"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupPrimary = exports.ClusterAdapter = exports.createAdapter = void 0;
const cluster = require("cluster");
const socket_io_adapter_1 = require("socket.io-adapter");
const crypto_1 = require("crypto");
const randomId = () => crypto_1.randomBytes(8).toString("hex");
const debug = require("debug")("socket.io-cluster-adapter");
const MESSAGE_SOURCE = "_sio_adapter";
const hasOwnProperty = Object.prototype.hasOwnProperty;
/**
 * Event types, for messages between nodes
 */
var EventType;
(function (EventType) {
    EventType[EventType["WORKER_INIT"] = 1] = "WORKER_INIT";
    EventType[EventType["WORKER_PING"] = 2] = "WORKER_PING";
    EventType[EventType["WORKER_EXIT"] = 3] = "WORKER_EXIT";
    EventType[EventType["BROADCAST"] = 4] = "BROADCAST";
    EventType[EventType["SOCKETS_JOIN"] = 5] = "SOCKETS_JOIN";
    EventType[EventType["SOCKETS_LEAVE"] = 6] = "SOCKETS_LEAVE";
    EventType[EventType["DISCONNECT_SOCKETS"] = 7] = "DISCONNECT_SOCKETS";
    EventType[EventType["FETCH_SOCKETS"] = 8] = "FETCH_SOCKETS";
    EventType[EventType["FETCH_SOCKETS_RESPONSE"] = 9] = "FETCH_SOCKETS_RESPONSE";
    EventType[EventType["SERVER_SIDE_EMIT"] = 10] = "SERVER_SIDE_EMIT";
    EventType[EventType["SERVER_SIDE_EMIT_RESPONSE"] = 11] = "SERVER_SIDE_EMIT_RESPONSE";
    EventType[EventType["BROADCAST_CLIENT_COUNT"] = 12] = "BROADCAST_CLIENT_COUNT";
    EventType[EventType["BROADCAST_ACK"] = 13] = "BROADCAST_ACK";
})(EventType || (EventType = {}));
/**
 * Returns a function that will create a ClusterAdapter instance.
 *
 * @param opts - additional options
 *
 * @public
 */
function createAdapter(opts = {}) {
    return function (nsp) {
        return new ClusterAdapter(nsp, opts);
    };
}
exports.createAdapter = createAdapter;
class ClusterAdapter extends socket_io_adapter_1.Adapter {
    /**
     * Adapter constructor.
     *
     * @param nsp - the namespace
     * @param opts - additional options
     *
     * @public
     */
    constructor(nsp, opts = {}) {
        super(nsp);
        this.workerIds = new Set();
        this.requests = new Map();
        this.ackRequests = new Map();
        this.requestsTimeout = opts.requestsTimeout || 5000;
        this.publish({
            type: EventType.WORKER_INIT,
            data: cluster.worker.id,
        });
        process.on("message", this.onMessage.bind(this));
    }
    async onMessage(message) {
        const isValidSource = (message === null || message === void 0 ? void 0 : message.source) === MESSAGE_SOURCE;
        if (!isValidSource) {
            return;
        }
        if (message.type === EventType.WORKER_EXIT) {
            this.workerIds.delete(message.data);
            debug("workers count is now %d", this.workerIds.size);
            return;
        }
        if (message.nsp !== this.nsp.name) {
            debug("ignore other namespace");
            return;
        }
        switch (message.type) {
            case EventType.WORKER_INIT:
                this.workerIds.add(message.data);
                debug("workers count is now %d", this.workerIds.size);
                this.publish({
                    type: EventType.WORKER_PING,
                    data: cluster.worker.id,
                });
                break;
            case EventType.WORKER_PING:
                this.workerIds.add(message.data);
                debug("workers count is now %d", this.workerIds.size);
                break;
            case EventType.BROADCAST: {
                debug("broadcast with opts %j", message.data.opts);
                const withAck = message.data.requestId !== undefined;
                if (withAck) {
                    super.broadcastWithAck(message.data.packet, ClusterAdapter.deserializeOptions(message.data.opts), (clientCount) => {
                        debug("waiting for %d client acknowledgements", clientCount);
                        this.publish({
                            type: EventType.BROADCAST_CLIENT_COUNT,
                            data: {
                                requestId: message.data.requestId,
                                clientCount,
                            },
                        });
                    }, (arg) => {
                        debug("received acknowledgement with value %j", arg);
                        this.publish({
                            type: EventType.BROADCAST_ACK,
                            data: {
                                requestId: message.data.requestId,
                                packet: arg,
                            },
                        });
                    });
                }
                else {
                    super.broadcast(message.data.packet, ClusterAdapter.deserializeOptions(message.data.opts));
                }
                break;
            }
            case EventType.BROADCAST_CLIENT_COUNT: {
                const request = this.ackRequests.get(message.data.requestId);
                request === null || request === void 0 ? void 0 : request.clientCountCallback(message.data.clientCount);
                break;
            }
            case EventType.BROADCAST_ACK: {
                const request = this.ackRequests.get(message.data.requestId);
                request === null || request === void 0 ? void 0 : request.ack(message.data.packet);
                break;
            }
            case EventType.SOCKETS_JOIN: {
                debug("calling addSockets with opts %j", message.data.opts);
                super.addSockets(ClusterAdapter.deserializeOptions(message.data.opts), message.data.rooms);
                break;
            }
            case EventType.SOCKETS_LEAVE: {
                debug("calling delSockets with opts %j", message.data.opts);
                super.delSockets(ClusterAdapter.deserializeOptions(message.data.opts), message.data.rooms);
                break;
            }
            case EventType.DISCONNECT_SOCKETS: {
                debug("calling disconnectSockets with opts %j", message.data.opts);
                super.disconnectSockets(ClusterAdapter.deserializeOptions(message.data.opts), message.data.close);
                break;
            }
            case EventType.FETCH_SOCKETS: {
                debug("calling fetchSockets with opts %j", message.data.opts);
                const localSockets = await super.fetchSockets(ClusterAdapter.deserializeOptions(message.data.opts));
                this.publish({
                    type: EventType.FETCH_SOCKETS_RESPONSE,
                    data: {
                        requestId: message.data.requestId,
                        workerId: message.data.workerId,
                        sockets: localSockets.map((socket) => ({
                            id: socket.id,
                            handshake: socket.handshake,
                            rooms: [...socket.rooms],
                            data: socket.data,
                        })),
                    },
                });
                break;
            }
            case EventType.FETCH_SOCKETS_RESPONSE: {
                const request = this.requests.get(message.data.requestId);
                if (!request) {
                    return;
                }
                request.current++;
                message.data.sockets.forEach((socket) => request.responses.push(socket));
                if (request.current === request.expected) {
                    clearTimeout(request.timeout);
                    request.resolve(request.responses);
                    this.requests.delete(message.data.requestId);
                }
                break;
            }
            case EventType.SERVER_SIDE_EMIT: {
                const packet = message.data.packet;
                const withAck = message.data.requestId !== undefined;
                if (!withAck) {
                    this.nsp._onServerSideEmit(packet);
                    return;
                }
                let called = false;
                const callback = (arg) => {
                    // only one argument is expected
                    if (called) {
                        return;
                    }
                    called = true;
                    debug("calling acknowledgement with %j", arg);
                    this.publish({
                        type: EventType.SERVER_SIDE_EMIT_RESPONSE,
                        data: {
                            requestId: message.data.requestId,
                            workerId: message.data.workerId,
                            packet: arg,
                        },
                    });
                };
                packet.push(callback);
                this.nsp._onServerSideEmit(packet);
                break;
            }
            case EventType.SERVER_SIDE_EMIT_RESPONSE: {
                const request = this.requests.get(message.data.requestId);
                if (!request) {
                    return;
                }
                request.current++;
                request.responses.push(message.data.packet);
                if (request.current === request.expected) {
                    clearTimeout(request.timeout);
                    request.resolve(null, request.responses);
                    this.requests.delete(message.data.requestId);
                }
            }
        }
    }
    async publish(message) {
        // to be able to ignore unrelated messages on the cluster message bus
        message.source = MESSAGE_SOURCE;
        // to be able to ignore messages from other namespaces
        message.nsp = this.nsp.name;
        debug("publish event of type %s for namespace %s", message.type, message.nsp);
        process.send(message);
    }
    /**
     * Transform ES6 Set into plain arrays.
     *
     * Note: we manually serialize ES6 Sets so that using `serialization: "advanced"` is not needed when using plaintext
     * packets (reference: https://nodejs.org/api/child_process.html#child_process_advanced_serialization)
     */
    static serializeOptions(opts) {
        return {
            rooms: [...opts.rooms],
            except: opts.except ? [...opts.except] : [],
            flags: opts.flags,
        };
    }
    static deserializeOptions(opts) {
        return {
            rooms: new Set(opts.rooms),
            except: new Set(opts.except),
            flags: opts.flags,
        };
    }
    broadcast(packet, opts) {
        var _a;
        const onlyLocal = (_a = opts === null || opts === void 0 ? void 0 : opts.flags) === null || _a === void 0 ? void 0 : _a.local;
        if (!onlyLocal) {
            this.publish({
                type: EventType.BROADCAST,
                data: {
                    packet,
                    opts: ClusterAdapter.serializeOptions(opts),
                },
            });
        }
        // packets with binary contents are modified by the broadcast method, hence the nextTick()
        process.nextTick(() => {
            super.broadcast(packet, opts);
        });
    }
    broadcastWithAck(packet, opts, clientCountCallback, ack) {
        var _a;
        const onlyLocal = (_a = opts === null || opts === void 0 ? void 0 : opts.flags) === null || _a === void 0 ? void 0 : _a.local;
        if (!onlyLocal) {
            const requestId = randomId();
            this.publish({
                type: EventType.BROADCAST,
                data: {
                    packet,
                    requestId,
                    opts: ClusterAdapter.serializeOptions(opts),
                },
            });
            this.ackRequests.set(requestId, {
                type: EventType.BROADCAST,
                clientCountCallback,
                ack,
            });
            // we have no way to know at this level whether the server has received an acknowledgement from each client, so we
            // will simply clean up the ackRequests map after the given delay
            setTimeout(() => {
                this.ackRequests.delete(requestId);
            }, opts.flags.timeout);
        }
        // packets with binary contents are modified by the broadcast method, hence the nextTick()
        process.nextTick(() => {
            super.broadcastWithAck(packet, opts, clientCountCallback, ack);
        });
    }
    serverCount() {
        return Promise.resolve(1 + this.workerIds.size);
    }
    addSockets(opts, rooms) {
        var _a;
        super.addSockets(opts, rooms);
        const onlyLocal = (_a = opts.flags) === null || _a === void 0 ? void 0 : _a.local;
        if (onlyLocal) {
            return;
        }
        this.publish({
            type: EventType.SOCKETS_JOIN,
            data: {
                opts: ClusterAdapter.serializeOptions(opts),
                rooms,
            },
        });
    }
    delSockets(opts, rooms) {
        var _a;
        super.delSockets(opts, rooms);
        const onlyLocal = (_a = opts.flags) === null || _a === void 0 ? void 0 : _a.local;
        if (onlyLocal) {
            return;
        }
        this.publish({
            type: EventType.SOCKETS_LEAVE,
            data: {
                opts: ClusterAdapter.serializeOptions(opts),
                rooms,
            },
        });
    }
    disconnectSockets(opts, close) {
        var _a;
        super.disconnectSockets(opts, close);
        const onlyLocal = (_a = opts.flags) === null || _a === void 0 ? void 0 : _a.local;
        if (onlyLocal) {
            return;
        }
        this.publish({
            type: EventType.DISCONNECT_SOCKETS,
            data: {
                opts: ClusterAdapter.serializeOptions(opts),
                close,
            },
        });
    }
    getExpectedResponseCount() {
        return this.workerIds.size;
    }
    async fetchSockets(opts) {
        var _a;
        const localSockets = await super.fetchSockets(opts);
        const expectedResponseCount = this.getExpectedResponseCount();
        if (((_a = opts.flags) === null || _a === void 0 ? void 0 : _a.local) || expectedResponseCount === 0) {
            return localSockets;
        }
        const requestId = randomId();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                const storedRequest = this.requests.get(requestId);
                if (storedRequest) {
                    reject(new Error(`timeout reached: only ${storedRequest.current} responses received out of ${storedRequest.expected}`));
                    this.requests.delete(requestId);
                }
            }, this.requestsTimeout);
            const storedRequest = {
                type: EventType.FETCH_SOCKETS,
                resolve,
                timeout,
                current: 0,
                expected: expectedResponseCount,
                responses: localSockets,
            };
            this.requests.set(requestId, storedRequest);
            this.publish({
                type: EventType.FETCH_SOCKETS,
                data: {
                    requestId,
                    workerId: cluster.worker.id,
                    opts: ClusterAdapter.serializeOptions(opts),
                },
            });
        });
    }
    serverSideEmit(packet) {
        const withAck = typeof packet[packet.length - 1] === "function";
        if (withAck) {
            this.serverSideEmitWithAck(packet).catch(() => {
                // ignore errors
            });
            return;
        }
        this.publish({
            type: EventType.SERVER_SIDE_EMIT,
            data: {
                packet,
            },
        });
    }
    async serverSideEmitWithAck(packet) {
        const ack = packet.pop();
        const expectedResponseCount = this.getExpectedResponseCount();
        debug('waiting for %d responses to "serverSideEmit" request', expectedResponseCount);
        if (expectedResponseCount <= 0) {
            return ack(null, []);
        }
        const requestId = randomId();
        const timeout = setTimeout(() => {
            const storedRequest = this.requests.get(requestId);
            if (storedRequest) {
                ack(new Error(`timeout reached: only ${storedRequest.current} responses received out of ${storedRequest.expected}`), storedRequest.responses);
                this.requests.delete(requestId);
            }
        }, this.requestsTimeout);
        const storedRequest = {
            type: EventType.FETCH_SOCKETS,
            resolve: ack,
            timeout,
            current: 0,
            expected: expectedResponseCount,
            responses: [],
        };
        this.requests.set(requestId, storedRequest);
        this.publish({
            type: EventType.SERVER_SIDE_EMIT,
            data: {
                requestId,
                workerId: cluster.worker.id,
                packet,
            },
        });
    }
}
exports.ClusterAdapter = ClusterAdapter;
function setupPrimary() {
    cluster.on("message", (worker, message) => {
        const isValidSource = (message === null || message === void 0 ? void 0 : message.source) === MESSAGE_SOURCE;
        if (!isValidSource) {
            return;
        }
        switch (message.type) {
            case EventType.FETCH_SOCKETS_RESPONSE:
            case EventType.SERVER_SIDE_EMIT_RESPONSE:
                const workerId = message.data.workerId;
                // emit back to the requester
                if (hasOwnProperty.call(cluster.workers, workerId)) {
                    cluster.workers[workerId].send(message);
                }
                break;
            default:
                const emitterIdAsString = "" + worker.id;
                // emit to all workers but the requester
                for (const workerId in cluster.workers) {
                    if (hasOwnProperty.call(cluster.workers, workerId) &&
                        workerId !== emitterIdAsString) {
                        cluster.workers[workerId].send(message);
                    }
                }
        }
    });
    var sigintted = false;
    process.on('SIGINT', () => { sigintted = true; });
    cluster.on("exit", (worker) => {
        // After SIGINT, cluster master is going to kill itself.
        // Updating WORKER_EXIT doesn't matter anymore.
        // And most workers are might already dead.
        if (sigintted)
            return;
        // notify all active workers
        for (const workerId in cluster.workers) {
            if (hasOwnProperty.call(cluster.workers, workerId)) {
                try {
                    cluster.workers[workerId].send({
                        source: MESSAGE_SOURCE,
                        type: EventType.WORKER_EXIT,
                        data: worker.id,
                    }, undefined, (e) => {
                        if (e !== null) {
                            console.log('caught an err, but ok', e);
                        }
                    });
                }
                catch (e) {
                    console.log('caught an err, but ok too', e);
                }
            }
        }
    });
}
exports.setupPrimary = setupPrimary;
