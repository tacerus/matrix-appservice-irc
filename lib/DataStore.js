/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";

var Promise = require("bluebird");

var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
var MatrixUser = require("matrix-appservice-bridge").MatrixUser;
var RemoteUser = require("matrix-appservice-bridge").RemoteUser;
var IrcRoom = require("./models/IrcRoom");
var IrcClientConfig = require("./models/IrcClientConfig");
var log = require("./logging").get("DataStore");

function DataStore(userStore, roomStore) {
    this._roomStore = roomStore;
    this._userStore = userStore;
    this._serverMappings = {}; // { domain: IrcServer }
}

DataStore.prototype.setServerFromConfig = Promise.coroutine(function*(server, serverConfig) {
    this._serverMappings[server.domain] = server;

    var channels = Object.keys(serverConfig.mappings);
    for (var i = 0; i < channels.length; i++) {
        var channel = channels[i];
        for (var k = 0; k < serverConfig.mappings[channel].length; k++) {
            var ircRoom = new IrcRoom(server, channel);
            var mxRoom = new MatrixRoom(
                serverConfig.mappings[channel][k]
            );
            yield this.storeRoom(ircRoom, mxRoom, true);
        }
    }
});

/**
 * Persists an IRC <--> Matrix room mapping in the database.
 * @param {IrcRoom} ircRoom : The IRC room to store.
 * @param {MatrixRoom} matrixRoom : The Matrix room to store.
 * @param {boolean} fromConfig : True if this mapping is from the config yaml.
 * @return {Promise}
 */
DataStore.prototype.storeRoom = function(ircRoom, matrixRoom, fromConfig) {
    fromConfig = Boolean(fromConfig);
    log.info("storeRoom (id=%s, addr=%s, chan=%s, config=%s)",
        matrixRoom.getId(), ircRoom.get("domain"), ircRoom.channel, fromConfig);
    return this._roomStore.linkRooms(matrixRoom, ircRoom, {
        from_config: fromConfig
    });
};

/**
 * Retrieve a list of IRC rooms for a given room ID.
 * @param {string} roomId : The room ID to get mapped IRC channels.
 * @return {Promise<Array<IrcRoom>>} A promise which resolves to a list of
 * rooms.
 */
DataStore.prototype.getIrcChannelsForRoomId = function(roomId) {
    return this._roomStore.getLinkedRemoteRooms(roomId).then((remoteRooms) => {
        return remoteRooms.filter((remoteRoom) => {
            return Boolean(this._serverMappings[remoteRoom.get("domain")]);
        }).map((remoteRoom) => {
            let server = this._serverMappings[remoteRoom.get("domain")];
            return IrcRoom.fromRemoteRoom(server, remoteRoom);
        });
    });
};

/**
 * Retrieve a list of Matrix rooms for a given server and channel.
 * @param {IrcServer} server : The server to get rooms for.
 * @param {string} channel : The channel to get mapped rooms for.
 * @return {Promise<Array<MatrixRoom>>} A promise which resolves to a list of rooms.
 */
DataStore.prototype.getMatrixRoomsForChannel = function(server, channel) {
    var ircRoom = new IrcRoom(server, channel);
    return this._roomStore.getLinkedMatrixRooms(
        IrcRoom.createId(ircRoom.getServer(), ircRoom.getChannel())
    );
};

DataStore.prototype.setPmRoom = function(ircRoom, matrixRoom, userId, virtualUserId) {
    log.info("setPmRoom (id=%s, addr=%s chan=%s real=%s virt=%s)",
        matrixRoom.getId(), ircRoom.server.domain, ircRoom.channel, userId,
        virtualUserId);

    var linkKey = createPmLinkKey(userId, virtualUserId);

    return this._roomStore.linkRooms(matrixRoom, ircRoom, {
        real_user_id: userId,
        virtual_user_id: virtualUserId
    }, linkKey);
};

DataStore.prototype.getMatrixPmRoom = function(realUserId, virtualUserId) {
    var linkKey = createPmLinkKey(realUserId, virtualUserId);
    return this._roomStore.getLinksByKey(linkKey).then(function(links) {
        if (links.length > 1) {
            log.error("getMatrixPmRoom found >1 PM rooms for %s", realUserId);
        }
        var link = links[0];
        if (!link) {
            return null;
        }
        return new MatrixRoom(link.matrix);
    });
};

DataStore.prototype.getTrackedChannelsForServer = function(ircAddr) {
    return this._roomStore.getRemoteRooms({ domain: ircAddr }).then((rooms) => {
        var channels = [];
        rooms.forEach((r) => {
            let server = this._serverMappings[r.get("domain")];
            if (!server) {
                return;
            }
            let ircRoom = IrcRoom.fromRemoteRoom(server, r);
            if (ircRoom.getType() === "channel") {
                channels.push(ircRoom.getChannel());
            }
        });
        return channels;
    });
};

DataStore.prototype.getRoomIdsFromConfig = function() {
    return this._roomStore.getLinksByData({
        from_config: true
    }).then(function(links) {
        return links.map((link) => {
            return link.matrix;
        });
    });
};

DataStore.prototype.removeConfigMappings = function() {
    return this._roomStore.unlinkByData({
        from_config: true
    });
};

DataStore.prototype.getIpv6Counter = Promise.coroutine(function*() {
    let config = yield this._userStore.getRemoteUser("config");
    if (!config) {
        config = new RemoteUser("config");
        config.set("ipv6_counter", 0);
        yield this._userStore.setRemoteUser(config);
    }
    return config.get("ipv6_counter");
});

DataStore.prototype.setIpv6Counter = Promise.coroutine(function*(counter) {
    let config = yield this._userStore.getRemoteUser("config");
    if (!config) {
        config = new RemoteUser("config");
    }
    config.set("ipv6_counter", counter);
    yield this._userStore.setRemoteUser(config);
});

/**
 * Retrieve a stored admin room based on the room's ID.
 * @param {String} roomId : The room ID of the admin room.
 * @return {Promise} Resolved when the room is retrieved.
 */
DataStore.prototype.getAdminRoomById = function(roomId) {
    return this._roomStore.getMatrixRoom(roomId);
};

/**
 * Stores a unique admin room for a given user ID.
 * @param {MatrixRoom} room : The matrix room which is the admin room for this user.
 * @param {String} userId : The user ID who is getting an admin room.
 * @return {Promise} Resolved when the room is stored.
 */
DataStore.prototype.storeAdminRoom = function(room, userId) {
    log.info("storeAdminRoom (id=%s, user_id=%s)", room.getId(), userId);
    room.set("admin_id", userId);
    return this._roomStore.setMatrixRoom(room, {
        "extras.admin_id": userId
    })
};

DataStore.prototype.getAdminRoomByUserId = function(userId) {
    return this._roomStore.getMatrixRoom({
        "extras.admin_id": userId
    });
};

DataStore.prototype.storeMatrixUser = function(matrixUser) {
    return this._userStore.setMatrixUser(matrixUser);
};

DataStore.prototype.getMatrixUserByLocalpart = function(localpart) {
    return this._userStore.getByMatrixLocalpart(localpart);
};

DataStore.prototype.getIrcClientConfig = function(userId, domain) {
    return this._userStore.getMatrixUser(userId).then((matrixUser) => {
        if (!matrixUser) {
            return null;
        }
        var userConfig = matrixUser.get("client_config");
        if (!userConfig) {
            return null;
        }
        // map back from _ to .
        Object.keys(userConfig).forEach(function(domainWithUnderscores) {
            let actualDomain = domainWithUnderscores.replace(/_/g, ".");
            if (actualDomain !== domainWithUnderscores) { // false for 'localhost'
                userConfig[actualDomain] = userConfig[domainWithUnderscores];
                delete userConfig[domainWithUnderscores];
            }
        })
        var configData = userConfig[domain];
        if (!configData) {
            return null;
        }
        return new IrcClientConfig(userId, domain, configData);
    });
};

DataStore.prototype.storeIrcClientConfig = function(config) {
    log.info("Storing " + config);
    return this._userStore.getMatrixUser(config.getUserId()).then((user) => {
        if (!user) {
            user = new MatrixUser(config.getUserId());
        }
        var userConfig = user.get("client_config") || {};
        userConfig[config.getDomain().replace(/\./g, "_")] = config.serialize();
        user.set("client_config", userConfig);
        return this._userStore.setMatrixUser(user);
    });
};

DataStore.prototype.getMatrixUserByUsername = Promise.coroutine(
function*(domain, username) {
    let domainKey = domain.replace(/\./g, "_");
    let matrixUsers = yield this._userStore.getByMatrixData({
        ["client_config." + domainKey + ".username"]: username
    });

    if (matrixUsers.length > 1) {
        log.error(
            "getMatrixUserByUsername return %s results for %s on %s",
            matrixUsers.length, username, domain
        );
    }
    return matrixUsers[0];
});

function createPmLinkKey(userId, virtualUserId) {
    return "PM " + userId + " " + virtualUserId; // clobber based on this.
}

module.exports = DataStore;