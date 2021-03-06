const EventEmitter = require('events').EventEmitter;
const protoo = require('protoo-server');
const throttle = require('@sitespeed.io/throttle');
const Logger = require('./Logger');
const config = require('../config');

const logger = new Logger('LPZ demo-Room');

/**
 * Room class.
 *
 * This is not a "mediasoup Room" by itself, by a custom class that holds
 * a protoo Room (for signaling with WebSocket clients) and a mediasoup Router
 * (for sending and receiving media to/from those WebSocket peers).
 */
class Room extends EventEmitter
{
	/**
	 * Factory function that creates and returns Room instance.
	 *
	 * @async
	 *
	 * @param {mediasoup.Worker} mediasoupWorker - The mediasoup Worker in which a new
	 *   mediasoup Router must be created.
	 * @param {String} roomId - Id of the Room instance.
	 * @param {Boolean} [forceH264=false] - Whether just H264 must be used in the
	 *   mediasoup Router video codecs.
	 */
	static async create({ mediasoupWorker, roomId, forceH264 = false })
	{
		logger.info('create() [mediasoupWorker:%o, roomId:%s, forceH264:%s]', mediasoupWorker, roomId, forceH264);

		// Create a protoo Room instance.
		const protooRoom = new protoo.Room();

		// Router media codecs.
		let mediaCodecs = config.mediasoup.router.mediaCodecs;
		logger.debug('create() [mediaCodecs:%o, config:%o]', mediaCodecs, config);

		// If forceH264 is given, remove all video codecs but H264.
		if (forceH264)
		{
			mediaCodecs = mediaCodecs
				.filter((codec) => (
					codec.kind === 'audio' ||
					codec.mimeType.toLowerCase() === 'video/h264'
				));
			logger.debug('create() [mediaCodecs:%o]', mediaCodecs);
		}

		logger.debug('create() createRouter enter, [mediaCodecs:%o]', mediaCodecs);

		// Create a mediasoup Router.
		const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });

		logger.debug('create() createRouter exit, [mediasoupRouter:%o]', mediasoupRouter);

		// Create a mediasoup AudioLevelObserver.
		const audioLevelObserver = await mediasoupRouter.createAudioLevelObserver(
			{
				maxEntries : 1,
				threshold  : -80,
				interval   : 800
			});

		logger.debug('create() createAudioLevelObserver, [audioLevelObserver:%o]', audioLevelObserver);
		return new Room({ roomId, protooRoom, mediasoupRouter, audioLevelObserver });
	}

	constructor({ roomId, protooRoom, mediasoupRouter, audioLevelObserver })
	{
		super();
		this.setMaxListeners(Infinity);

		logger.debug('constructor, [roomId:%o]', roomId);

		// Room id.
		// @type {String}
		this._roomId = roomId;

		// Closed flag.
		// @type {Boolean}
		this._closed = false;

		// protoo Room instance.
		// @type {protoo.Room}
		this._protooRoom = protooRoom;

		// Map of broadcasters indexed by id. Each Object has:
		// - {String} id
		// - {Object} data
		//   - {String} displayName
		//   - {Object} device
		//   - {RTCRtpCapabilities} rtpCapabilities
		//   - {Map<String, mediasoup.Transport>} transports
		//   - {Map<String, mediasoup.Producer>} producers
		//   - {Map<String, mediasoup.Consumers>} consumers
		// @type {Map<String, Object>}
		this._broadcasters = new Map();

		// mediasoup Router instance.
		// @type {mediasoup.Router}
		this._mediasoupRouter = mediasoupRouter;

		// mediasoup AudioLevelObserver.
		// @type {mediasoup.AudioLevelObserver}
		this._audioLevelObserver = audioLevelObserver;

		// Network throttled.
		// @type {Boolean}
		this._networkThrottled = false;

		// Set audioLevelObserver events.
		this._audioLevelObserver.on('volumes', (volumes) =>
		{
			const { producer, volume } = volumes[0];

			logger.debug('constructor, volumes, [producer:%o, volume:%o]', producer, volume);
			
			// logger.debug(
			// 	'audioLevelObserver "volumes" event [producerId:%s, volume:%s]',
			// 	producer.id, volume);

			// Notify all Peers.
			for (const peer of this._getJoinedPeers())
			{
				peer.notify(
					'activeSpeaker',
					{
						peerId : producer.appData.peerId,
						volume : volume
					})
					.catch(() => {});
			}
		});

		this._audioLevelObserver.on('silence', () =>
		{
			logger.debug('constructor, silence');
			// logger.debug('audioLevelObserver "silence" event');

			// Notify all Peers.
			for (const peer of this._getJoinedPeers())
			{
				peer.notify('activeSpeaker', { peerId: null })
					.catch(() => {});
			}
		});

		// For debugging.
		global.audioLevelObserver = this._audioLevelObserver;
	}

	/**
	 * Closes the Room instance by closing the protoo Room and the mediasoup Router.
	 */
	close()
	{
		logger.debug('close()');

		this._closed = true;

		// Close the protoo Room.
		this._protooRoom.close();

		// Close the mediasoup Router.
		this._mediasoupRouter.close();

		// Emit 'close' event.
		this.emit('close');

		// Stop network throttling.
		if (this._networkThrottled)
		{
			throttle.stop({})
				.catch(() => {});
		}
	}

	logStatus()
	{
		logger.info(
			'logStatus() [roomId:%s, protoo Peers:%s, mediasoup Transports:%s]',
			this._roomId,
			this._protooRoom.peers.length,
			this._mediasoupRouter._transports.size); // NOTE: Private API.
	}

	/**
	 * Called from server.js upon a protoo WebSocket connection request from a
	 * browser.
	 *
	 * @param {String} peerId - The id of the protoo peer to be created.
	 * @param {Boolean} consume - Whether this peer wants to consume from others.
	 * @param {protoo.WebSocketTransport} protooWebSocketTransport - The associated
	 *   protoo WebSocket transport.
	 */
	handleProtooConnection({ peerId, consume, protooWebSocketTransport })
	{
		logger.debug('handleProtooConnection() | [peerId:%o, consume:%o]', peerId, consume);
		const existingPeer = this._protooRoom.getPeer(peerId);

		if (existingPeer)
		{
			logger.warn(
				'handleProtooConnection() | there is already a protoo Peer with same peerId, closing it [peerId:%s]',
				peerId);

			existingPeer.close();
		}

		let peer;

		// Create a new protoo Peer with the given peerId.
		try
		{
			peer = this._protooRoom.createPeer(peerId, protooWebSocketTransport);
		}
		catch (error)
		{
			logger.error('protooRoom.createPeer() failed:%o', error);
		}

		// Use the peer.data object to store mediasoup related objects.

		// Not joined after a custom protoo 'join' request is later received.
		peer.data.consume = consume;
		peer.data.joined = false;
		peer.data.displayName = undefined;
		peer.data.device = undefined;
		peer.data.rtpCapabilities = undefined;

		// Have mediasoup related maps ready even before the Peer joins since we
		// allow creating Transports before joining.
		peer.data.transports = new Map();
		peer.data.producers = new Map();
		peer.data.consumers = new Map();

		peer.on('request', (request, accept, reject) =>
		{
			logger.debug(
				'protoo Peer "request" event [method:%s, peerId:%s]',
				request.method, peer.id);

			this._handleProtooRequest(peer, request, accept, reject)
				.catch((error) =>
				{
					logger.error('request failed:%o', error);

					reject(error);
				});
		});

		peer.on('close', () =>
		{
			if (this._closed)
				return;

			logger.debug('protoo Peer "close" event [peerId:%s]', peer.id);

			// If the Peer was joined, notify all Peers.
			if (peer.data.joined)
			{
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.notify('peerClosed', { peerId: peer.id })
						.catch(() => {});
				}
			}

			// Iterate and close all mediasoup Transport associated to this Peer, so all
			// its Producers and Consumers will also be closed.
			for (const transport of peer.data.transports.values())
			{
				transport.close();
			}

			// If this is the latest Peer in the room, close the room after a while.
			if (this._protooRoom.peers.length === 0)
			{
				setTimeout(() =>
				{
					if (this._closed)
						return;

					if (this._protooRoom.peers.length === 0)
					{
						logger.info(
							'last Peer in the room left, closing the room [roomId:%s]',
							this._roomId);

						this.close();
					}
				}, 60000);
			}
		});
	}

	getRouterRtpCapabilities()
	{
		return this._mediasoupRouter.rtpCapabilities;
	}

	/**
	 * Create a Broadcaster. This is for HTTP API requests (see server.js).
	 *
	 * @async
	 *
	 * @type {String} id - Broadcaster id.
	 * @type {String} displayName - Descriptive name.
	 * @type {Object} [device] - Additional info with name, version and flags fields.
	 * @type {RTCRtpCapabilities} [rtpCapabilities] - Device RTP capabilities.
	 */
	async createBroadcaster({ id, displayName, device = {}, rtpCapabilities })
	{
		logger.debug('createBroadcaster, [id:%o, displayName:%o, device:%o, rtpCapabilities:%o]', id, displayName, device, rtpCapabilities);
		if (typeof id !== 'string' || !id)
			throw new TypeError('missing body.id');
		else if (typeof displayName !== 'string' || !displayName)
			throw new TypeError('missing body.displayName');
		else if (typeof device.name !== 'string' || !device.name)
			throw new TypeError('missing body.device.name');
		else if (rtpCapabilities && typeof rtpCapabilities !== 'object')
			throw new TypeError('wrong body.rtpCapabilities');

		if (this._broadcasters.has(id))
			throw new Error(`broadcaster with id "${id}" already exists`);

		const broadcaster =
		{
			id,
			data :
			{
				displayName,
				device :
				{
					flag    : 'broadcaster',
					name    : device.name || 'Unknown device',
					version : device.version
				},
				rtpCapabilities,
				transports : new Map(),
				producers  : new Map(),
				consumers  : new Map()
			}
		};

		// Store the Broadcaster into the map.
		this._broadcasters.set(broadcaster.id, broadcaster);

		// Notify the new Broadcaster to all Peers.
		for (const otherPeer of this._getJoinedPeers())
		{
			otherPeer.notify(
				'newPeer',
				{
					id          : broadcaster.id,
					displayName : broadcaster.data.displayName,
					device      : broadcaster.data.device
				})
				.catch(() => {});
		}

		// Reply with the list of Peers and their Producers.
		const peerInfos = [];
		const joinedPeers = this._getJoinedPeers();

		// Just fill the list of Peers if the Broadcaster provided its rtpCapabilities.
		if (rtpCapabilities)
		{
			for (const joinedPeer of joinedPeers)
			{
				const peerInfo =
				{
					id          : joinedPeer.id,
					displayName : joinedPeer.data.displayName,
					device      : joinedPeer.data.device,
					producers   : []
				};

				for (const producer of joinedPeer.data.producers.values())
				{
					// Ignore Producers that the Broadcaster cannot consume.
					if (
						!this._mediasoupRouter.canConsume(
							{
								producerId : producer.id,
								rtpCapabilities
							})
					)
					{
						continue;
					}

					peerInfo.producers.push(
						{
							id   : producer.id,
							kind : producer.kind
						});
				}

				peerInfos.push(peerInfo);
			}
		}

		logger.debug('createBroadcaster, return [peerInfos:%o]', peerInfos);
		return { peers: peerInfos };
	}

	/**
	 * Delete a Broadcaster.
	 *
	 * @type {String} broadcasterId
	 */
	deleteBroadcaster({ broadcasterId })
	{
		const broadcaster = this._broadcasters.get(broadcasterId);
		logger.debug('deleteBroadcaster, [broadcasterId:%o, [broadcaster:%o]]', broadcasterId, broadcaster);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		for (const transport of broadcaster.data.transports.values())
		{
			transport.close();
		}

		this._broadcasters.delete(broadcasterId);

		for (const peer of this._getJoinedPeers())
		{
			peer.notify('peerClosed', { peerId: broadcasterId })
				.catch(() => {});
		}
	}

	/**
	 * Create a mediasoup Transport associated to a Broadcaster. It can be a
	 * PlainRtpTransport or a WebRtcTransport
	 *
	 * @async
	 *
	 * @type {String} broadcasterId
	 * @type {String} type - Can be 'plain' (PlainRtpTransport) or 'webrtc'
	 *   (WebRtcTransport).
	 * @type {Boolean} [rtcpMux=true] - Just for PlainRtpTransport, use RTCP mux.
	 * @type {Boolean} [comedia=true] - Just for PlainRtpTransport, enable remote IP:port
	 *   autodetection.
	 * @type {Boolean} [multiSource=false] - Just for PlainRtpTransport, allow RTP from any
	 *   remote IP and port (no RTCP feedback will be sent to the remote).
	 */
	async createBroadcasterTransport(
		{
			broadcasterId,
			type,
			rtcpMux = true,
			comedia = true,
			multiSource = false
		})
	{
		logger.debug('createBroadcasterTransport, [type:%o, rtcpMux:%o, comedia:%o, multiSource:%o]', type, rtcpMux, comedia, multiSource);
		const broadcaster = this._broadcasters.get(broadcasterId);
		logger.debug('createBroadcasterTransport, [broadcasterId:%o, [broadcaster:%o]]', broadcasterId, broadcaster);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		switch (type)
		{
			case 'webrtc':
			{
				const { initialAvailableOutgoingBitrate } = config.mediasoup.webRtcTransport;
				logger.debug('createBroadcasterTransport, webrtc, [config:%o, initialAvailableOutgoingBitrate:%o]', config, initialAvailableOutgoingBitrate);

				const transport = await this._mediasoupRouter.createWebRtcTransport(
					{
						listenIps : config.mediasoup.webRtcTransport.listenIps,
						enableUdp : true,
						enableTcp : false,
						initialAvailableOutgoingBitrate
					});

				logger.debug('createBroadcasterTransport, webrtc, [transport:%o]', transport);
				// Store it.
				broadcaster.data.transports.set(transport.id, transport);

				return {
					id             : transport.id,
					iceParameters  : transport.iceParameters,
					iceCandidates  : transport.iceCandidates,
					dtlsParameters : transport.dtlsParameters
				};
			}

			case 'plain':
			{
				const transport = await this._mediasoupRouter.createPlainRtpTransport(
					{
						listenIp    : config.mediasoup.webRtcTransport.listenIps[0],
						rtcpMux     : Boolean(rtcpMux),
						comedia     : Boolean(comedia),
						multiSource : Boolean(multiSource)
					});

				logger.debug('createBroadcasterTransport, plain, [transport:%o]', transport);
				// Store it.
				broadcaster.data.transports.set(transport.id, transport);

				return {
					id       : transport.id,
					ip       : transport.tuple.localIp,
					port     : transport.tuple.localPort,
					rtcpPort : transport.rtcpTuple ? transport.rtcpTuple.localPort : undefined
				};
			}

			default:
			{
				throw new TypeError('invalid type');
			}
		}
	}

	/**
	 * Connect a Broadcaster mediasoup WebRtcTransport.
	 *
	 * @async
	 *
	 * @type {String} broadcasterId
	 * @type {String} transportId
	 * @type {RTCDtlsParameters} dtlsParameters - Remote DTLS parameters.
	 */
	async connectBroadcasterTransport(
		{
			broadcasterId,
			transportId,
			dtlsParameters
		}
	)
	{
		logger.debug('connectBroadcasterTransport | [broadcasterId:%o, transportId:%o, dtlsParameters:%o]', broadcasterId, transportId, dtlsParameters);
		const broadcaster = this._broadcasters.get(broadcasterId);
		logger.debug('connectBroadcasterTransport | [broadcaster:%o]', broadcaster);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		const transport = broadcaster.data.transports.get(transportId);

		if (!transport)
			throw new Error(`transport with id "${transportId}" does not exist`);

		if (transport.constructor.name !== 'WebRtcTransport')
		{
			throw new Error(
				`transport with id "${transportId}" is not a WebRtcTransport`);
		}

		await transport.connect({ dtlsParameters });
	}

	/**
	 * Create a mediasoup Producer associated to a Broadcaster.
	 *
	 * @async
	 *
	 * @type {String} broadcasterId
	 * @type {String} transportId
	 * @type {String} kind - 'audio' or 'video' kind for the Producer.
	 * @type {RTCRtpParameters} rtpParameters - RTP parameters for the Producer.
	 */
	async createBroadcasterProducer(
		{
			broadcasterId,
			transportId,
			kind,
			rtpParameters
		}
	)
	{
		logger.debug('createBroadcasterProducer | [broadcasterId:%o, transportId:%o, kind:%o, rtpParameters:%o]', broadcasterId, transportId, kind, rtpParameters);
		const broadcaster = this._broadcasters.get(broadcasterId);
		logger.debug('createBroadcasterProducer | [broadcaster:%o]', broadcaster);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		const transport = broadcaster.data.transports.get(transportId);

		if (!transport)
			throw new Error(`transport with id "${transportId}" does not exist`);

		const producer =
			await transport.produce({ kind, rtpParameters });

		logger.debug('createBroadcasterProducer | [producer:%o]', producer);
		// Store it.
		broadcaster.data.producers.set(producer.id, producer);

		// Set Producer events.
		// producer.on('score', (score) =>
		// {
		// 	logger.debug(
		// 		'broadcaster producer "score" event [producerId:%s, score:%o]',
		// 		producer.id, score);
		// });

		producer.on('videoorientationchange', (videoOrientation) =>
		{
			logger.debug(
				'broadcaster producer "videoorientationchange" event [producerId:%s, videoOrientation:%o]',
				producer.id, videoOrientation);
		});

		// Optimization: Create a server-side Consumer for each Peer.
		for (const peer of this._getJoinedPeers())
		{
			this._createConsumer(
				{
					consumerPeer : peer,
					producerPeer : broadcaster,
					producer
				});
		}

		// Add into the audioLevelObserver.
		if (producer.kind === 'audio')
		{
			this._audioLevelObserver.addProducer({ producerId: producer.id })
				.catch(() => {});
		}

		logger.debug('createBroadcasterProducer | return [id:%o]', producer.id);
		return { id: producer.id };
	}

	/**
	 * Create a mediasoup Consumer associated to a Broadcaster.
	 *
	 * @async
	 *
	 * @type {String} broadcasterId
	 * @type {String} transportId
	 * @type {String} producerId
	 */
	async createBroadcasterConsumer(
		{
			broadcasterId,
			transportId,
			producerId
		}
	)
	{
		logger.debug('createBroadcasterConsumer | [broadcasterId:%o, transportId:%o, producerId:%o]', broadcasterId, transportId, producerId);
		const broadcaster = this._broadcasters.get(broadcasterId);
		logger.debug('createBroadcasterConsumer | [broadcaster:%o]', broadcaster);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		if (!broadcaster.data.rtpCapabilities)
			throw new Error('broadcaster does not have rtpCapabilities');

		const transport = broadcaster.data.transports.get(transportId);
		logger.debug('createBroadcasterConsumer | [transport:%o]', transport);

		if (!transport)
			throw new Error(`transport with id "${transportId}" does not exist`);

		const consumer = await transport.consume(
			{
				producerId,
				rtpCapabilities : broadcaster.data.rtpCapabilities
			});

		logger.debug('createBroadcasterConsumer | [consumer:%o]', consumer);

		// Store it.
		broadcaster.data.consumers.set(consumer.id, consumer);

		// Set Consumer events.
		consumer.on('transportclose', () =>
		{
			// Remove from its map.
			broadcaster.data.consumers.delete(consumer.id);
		});

		consumer.on('producerclose', () =>
		{
			// Remove from its map.
			broadcaster.data.consumers.delete(consumer.id);
		});

		return {
			id            : consumer.id,
			producerId,
			kind          : consumer.kind,
			rtpParameters : consumer.rtpParameters,
			type          : consumer.type
		};
	}

	/**
	 * Handle protoo requests from browsers.
	 *
	 * @async
	 */
	async _handleProtooRequest(peer, request, accept, reject)
	{
		switch (request.method)
		{
			case 'getRouterRtpCapabilities':
			{
				logger.debug('_handleProtooRequest | getRouterRtpCapabilities | [rtpCapabilities:%o]', this._mediasoupRouter.rtpCapabilities);
				accept(this._mediasoupRouter.rtpCapabilities);

				break;
			}

			case 'join':
			{
				logger.debug('_handleProtooRequest | join | [peer:%o]', peer);
				logger.debug('_handleProtooRequest | join | [request.data:%o]', request.data);

				// Ensure the Peer is not already joined.
				if (peer.data.joined)
					throw new Error('Peer already joined');

				const { displayName, device, rtpCapabilities } = request.data;

				// Store client data into the protoo Peer data object.
				peer.data.displayName = displayName;
				peer.data.device = device;
				peer.data.rtpCapabilities = rtpCapabilities;

				logger.debug('_handleProtooRequest | join | [peer.data:%o]', peer.data);
				// Tell the new Peer about already joined Peers.
				// And also create Consumers for existing Producers.

				const peerInfos = [];
				const joinedPeers =
					[ ...this._getJoinedPeers(), ...Array.from(this._broadcasters.values()) ];

				for (const joinedPeer of joinedPeers)
				{
					peerInfos.push(
						{
							id          : joinedPeer.id,
							displayName : joinedPeer.data.displayName,
							device      : joinedPeer.data.device
						});

					for (const producer of joinedPeer.data.producers.values())
					{
						this._createConsumer(
							{
								consumerPeer : peer,
								producerPeer : joinedPeer,
								producer
							});
					}
				}

				logger.debug('_handleProtooRequest | join | [peerInfos:%o]', peerInfos);
				accept({ peers: peerInfos });

				// Mark the new Peer as joined.
				peer.data.joined = true;

				// Notify the new Peer to all other Peers.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.notify(
						'newPeer',
						{
							id          : peer.id,
							displayName : peer.data.displayName,
							device      : peer.data.device
						})
						.catch(() => {});
				}

				break;
			}

			case 'createWebRtcTransport':
			{
				// NOTE: Don't require that the Peer is joined here, so the client can
				// initiate mediasoup Transports and be ready when he later joins.

				const { forceTcp, producing, consuming } = request.data;
				const {
					maxIncomingBitrate,
					initialAvailableOutgoingBitrate
				} = config.mediasoup.webRtcTransport;

				logger.debug('_handleProtooRequest | createWebRtcTransport | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | createWebRtcTransport | [config.mediasoup.webRtcTransport:%o]', config.mediasoup.webRtcTransport);

				const transport = await this._mediasoupRouter.createWebRtcTransport(
					{
						listenIps : config.mediasoup.webRtcTransport.listenIps,
						enableUdp : !forceTcp,
						enableTcp : true,
						preferUdp : true,
						initialAvailableOutgoingBitrate,
						appData   : { producing, consuming }
					});

				logger.debug('_handleProtooRequest | createWebRtcTransport | [transport:%o]', transport);
				// Store the WebRtcTransport into the protoo Peer data Object.
				peer.data.transports.set(transport.id, transport);

				accept(
					{
						id             : transport.id,
						iceParameters  : transport.iceParameters,
						iceCandidates  : transport.iceCandidates,
						dtlsParameters : transport.dtlsParameters
					});

				// If set, apply max incoming bitrate limit.
				if (maxIncomingBitrate)
				{
					try { await transport.setMaxIncomingBitrate(maxIncomingBitrate); }
					catch (error) {}
				}

				break;
			}

			case 'connectWebRtcTransport':
			{
				const { transportId, dtlsParameters } = request.data;
				const transport = peer.data.transports.get(transportId);

				logger.debug('_handleProtooRequest | connectWebRtcTransport | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | connectWebRtcTransport | [transport:%o]', transport);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				await transport.connect({ dtlsParameters });

				accept();

				break;
			}

			case 'restartIce':
			{
				const { transportId } = request.data;
				const transport = peer.data.transports.get(transportId);

				logger.debug('_handleProtooRequest | restartIce | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | restartIce | [transport:%o]', transport);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				const iceParameters = await transport.restartIce();

				logger.debug('_handleProtooRequest | restartIce | [iceParameters:%o]', iceParameters);

				accept(iceParameters);

				break;
			}

			case 'produce':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { transportId, kind, rtpParameters } = request.data;
				let { appData } = request.data;
				const transport = peer.data.transports.get(transportId);

				logger.debug('_handleProtooRequest | produce | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | produce | [transport:%o]', transport);
				logger.debug('_handleProtooRequest | produce | [peerId:%o]', peer.id);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				// Add peerId into appData to later get the associated Peer during
				// the 'loudest' event of the audioLevelObserver.
				appData = { ...appData, peerId: peer.id };

				const producer =
					await transport.produce({ kind, rtpParameters, appData });

				logger.debug('_handleProtooRequest | produce | [producer:%o]', producer);

				// Store the Producer into the protoo Peer data Object.
				peer.data.producers.set(producer.id, producer);

				// Set Producer events.
				producer.on('score', (score) =>
				{
					logger.debug(
					 	'producer "score" event [producerId:%s, score:%o]',
					 	producer.id, score);

					peer.notify('producerScore', { producerId: producer.id, score })
						.catch(() => {});
				});

				producer.on('videoorientationchange', (videoOrientation) =>
				{
					logger.debug(
						'producer "videoorientationchange" event [producerId:%s, videoOrientation:%o]',
						producer.id, videoOrientation);
				});

				accept({ id: producer.id });

				// Optimization: Create a server-side Consumer for each Peer.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					this._createConsumer(
						{
							consumerPeer : otherPeer,
							producerPeer : peer,
							producer
						});
				}

				// Add into the audioLevelObserver.
				if (producer.kind === 'audio')
				{
					this._audioLevelObserver.addProducer({ producerId: producer.id })
						.catch(() => {});
				}

				break;
			}

			case 'closeProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.data.producers.get(producerId);

				logger.debug('_handleProtooRequest | closeProducer | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | closeProducer | [producer:%o]', producer);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				producer.close();

				// Remove from its map.
				peer.data.producers.delete(producer.id);

				accept();

				break;
			}

			case 'pauseProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.data.producers.get(producerId);

				logger.debug('_handleProtooRequest | pauseProducer | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | pauseProducer | [producer:%o]', producer);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				await producer.pause();

				accept();

				break;
			}

			case 'resumeProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.data.producers.get(producerId);

				logger.debug('_handleProtooRequest | resumeProducer | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | resumeProducer | [producer:%o]', producer);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				await producer.resume();

				accept();

				break;
			}

			case 'pauseConsumer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				logger.debug('_handleProtooRequest | pauseConsumer | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | pauseConsumer | [consumer:%o]', consumer);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.pause();

				accept();

				break;
			}

			case 'resumeConsumer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				logger.debug('_handleProtooRequest | resumeConsumer | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | resumeConsumer | [consumer:%o]', consumer);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.resume();

				accept();

				break;
			}

			case 'setConsumerPreferedLayers':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId, spatialLayer, temporalLayer } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				logger.debug('_handleProtooRequest | setConsumerPreferedLayers | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | setConsumerPreferedLayers | [consumer:%o]', consumer);
				
				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.setPreferredLayers({ spatialLayer, temporalLayer });

				accept();

				break;
			}

			case 'requestConsumerKeyFrame':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				logger.debug('_handleProtooRequest | requestConsumerKeyFrame | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | requestConsumerKeyFrame | [consumer:%o]', consumer);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.requestKeyFrame();

				accept();

				break;
			}

			case 'changeDisplayName':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { displayName } = request.data;
				const oldDisplayName = peer.data.displayName;

				logger.debug('_handleProtooRequest | changeDisplayName | [request.data:%o]', request.data);

				// Store the display name into the custom data Object of the protoo
				// Peer.
				peer.data.displayName = displayName;

				// Notify other joined Peers.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.notify(
						'peerDisplayNameChanged',
						{
							peerId : peer.id,
							displayName,
							oldDisplayName
						})
						.catch(() => {});
				}

				accept();

				break;
			}

			case 'getTransportStats':
			{
				const { transportId } = request.data;
				const transport = peer.data.transports.get(transportId);

				logger.debug('_handleProtooRequest | getTransportStats | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | getTransportStats | [transport:%o]', transport);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				const stats = await transport.getStats();

				logger.debug('_handleProtooRequest | getTransportStats | [stats:%o]', stats);

				accept(stats);

				break;
			}

			case 'getProducerStats':
			{
				const { producerId } = request.data;
				const producer = peer.data.producers.get(producerId);

				logger.debug('_handleProtooRequest | getProducerStats | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | getProducerStats | [producer:%o]', producer);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				const stats = await producer.getStats();

				logger.debug('_handleProtooRequest | getProducerStats | [stats:%o]', stats);

				accept(stats);

				break;
			}

			case 'getConsumerStats':
			{
				const { consumerId } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				logger.debug('_handleProtooRequest | getConsumerStats | [request.data:%o]', request.data);
				logger.debug('_handleProtooRequest | getConsumerStats | [consumer:%o]', consumer);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				const stats = await consumer.getStats();

				logger.debug('_handleProtooRequest | getConsumerStats | [stats:%o]', stats);

				accept(stats);

				break;
			}

			case 'applyNetworkThrottle':
			{
				const DefaultUplink = 1000000;
				const DefaultDownlink = 1000000;
				const DefaultRtt = 0;

				const { uplink, downlink, rtt, secret } = request.data;

				logger.debug('_handleProtooRequest | applyNetworkThrottle | [request.data:%o]', request.data);

				if (!secret || secret !== process.env.NETWORK_THROTTLE_SECRET)
				{
					reject(403, 'operation NOT allowed, modda fuckaa');

					return;
				}

				try
				{
					await throttle.start(
						{
							up   : uplink || DefaultUplink,
							down : downlink || DefaultDownlink,
							rtt  : rtt || DefaultRtt
						});

					logger.warn(
						'network throttle set [uplink:%s, downlink:%s, rtt:%s]',
						uplink || DefaultUplink,
						downlink || DefaultDownlink,
						rtt || DefaultRtt);

					accept();
				}
				catch (error)
				{
					logger.error('network throttle apply failed: %o', error);

					reject(500, error.toString());
				}

				break;
			}

			case 'resetNetworkThrottle':
			{
				const { secret } = request.data;

				logger.debug('_handleProtooRequest | resetNetworkThrottle | [request.data:%o]', request.data);

				if (!secret || secret !== process.env.NETWORK_THROTTLE_SECRET)
				{
					reject(403, 'operation NOT allowed, modda fuckaa');

					return;
				}

				try
				{
					await throttle.stop({});

					logger.warn('network throttle stopped');

					accept();
				}
				catch (error)
				{
					logger.error('network throttle stop failed: %o', error);

					reject(500, error.toString());
				}

				break;
			}

			default:
			{
				logger.error('unknown request.method "%s"', request.method);

				reject(500, `unknown request.method "${request.method}"`);
			}
		}
	}

	/**
	 * Helper to get the list of joined protoo peers.
	 */
	_getJoinedPeers({ excludePeer = undefined } = {})
	{
		return this._protooRoom.peers
			.filter((peer) => peer.data.joined && peer !== excludePeer);
	}

	/**
	 * Creates a mediasoup Consumer for the given mediasoup Producer.
	 *
	 * @async
	 */
	async _createConsumer({ consumerPeer, producerPeer, producer })
	{
		logger.debug('_createConsumer | [consumerPeer:%o, producerPeer:%o, producer:%o]', consumerPeer, producerPeer, producer);

		// Optimization:
		// - Create the server-side Consumer. If video, do it paused.
		// - Tell its Peer about it and wait for its response.
		// - Upon receipt of the response, resume the server-side Consumer.
		// - If video, this will mean a single key frame requested by the
		//   server-side Consumer (when resuming it).

		// NOTE: Don't create the Consumer if the remote Peer cannot consume it.
		if (
			!consumerPeer.data.rtpCapabilities ||
			!this._mediasoupRouter.canConsume(
				{
					producerId      : producer.id,
					rtpCapabilities : consumerPeer.data.rtpCapabilities
				})
		)
		{
			logger.debug('_createConsumer | return 1');
			return;
		}

		// Must take the Transport the remote Peer is using for consuming.
		const transport = Array.from(consumerPeer.data.transports.values())
			.find((t) => t.appData.consuming);

		logger.debug('_createConsumer | [transport:%o]', transport);

		// This should not happen.
		if (!transport)
		{
			logger.warn('_createConsumer() | Transport for consuming not found');

			return;
		}

		// Create the Consumer in paused mode.
		let consumer;

		try
		{
			consumer = await transport.consume(
				{
					producerId      : producer.id,
					rtpCapabilities : consumerPeer.data.rtpCapabilities,
					paused          : producer.kind === 'video'
				});
			logger.debug('_createConsumer | transport.consume, [consumer:%o]', consumer);
		}
		catch (error)
		{
			logger.warn('_createConsumer() | transport.consume():%o', error);

			return;
		}

		// Store the Consumer into the protoo consumerPeer data Object.
		consumerPeer.data.consumers.set(consumer.id, consumer);

		// Set Consumer events.
		consumer.on('transportclose', () =>
		{
			logger.debug('_createConsumer | transportclose, [consumer.id:%o]', consumer.id);
			// Remove from its map.
			consumerPeer.data.consumers.delete(consumer.id);
		});

		consumer.on('producerclose', () =>
		{
			logger.debug('_createConsumer | producerclose, [consumer.id:%o]', consumer.id);
			// Remove from its map.
			consumerPeer.data.consumers.delete(consumer.id);

			consumerPeer.notify('consumerClosed', { consumerId: consumer.id })
				.catch(() => {});
		});

		consumer.on('producerpause', () =>
		{
			logger.debug('_createConsumer | producerpause, [consumer.id:%o]', consumer.id);
			consumerPeer.notify('consumerPaused', { consumerId: consumer.id })
				.catch(() => {});
		});

		consumer.on('producerresume', () =>
		{
			logger.debug('_createConsumer | producerresume, [consumer.id:%o]', consumer.id);
			consumerPeer.notify('consumerResumed', { consumerId: consumer.id })
				.catch(() => {});
		});

		consumer.on('score', (score) =>
		{
			// logger.debug(
			// 	'consumer "score" event [consumerId:%s, score:%o]',
			// 	consumer.id, score);

			logger.debug('_createConsumer | score, [consumer.id:%o, score:%o]', consumer.id, score);
			consumerPeer.notify('consumerScore', { consumerId: consumer.id, score })
				.catch(() => {});
		});

		consumer.on('layerschange', (layers) =>
		{
			logger.debug('_createConsumer | layerschange, [consumer.id:%o, layers:%o]', consumer.id, layers);
			consumerPeer.notify(
				'consumerLayersChanged',
				{
					consumerId    : consumer.id,
					spatialLayer  : layers ? layers.spatialLayer : null,
					temporalLayer : layers ? layers.temporalLayer : null
				})
				.catch(() => {});
		});

		// Send a protoo request to the remote Peer with Consumer parameters.
		try
		{
			logger.debug('_createConsumer | consumerPeer.request, newConsumer, [producerPeer:%o, producer:%o, consumer:%o]', producerPeer, producer, consumer);
			await consumerPeer.request(
				'newConsumer',
				{
					peerId         : producerPeer.id,
					producerId     : producer.id,
					id             : consumer.id,
					kind           : consumer.kind,
					rtpParameters  : consumer.rtpParameters,
					type           : consumer.type,
					appData        : producer.appData,
					producerPaused : consumer.producerPaused
				});

			// Now that we got the positive response from the remote Peer and, if
			// video, resume the Consumer to ask for an efficient key frame.
			if (producer.kind === 'video')
				await consumer.resume();

			consumerPeer.notify(
				'consumerScore',
				{
					consumerId : consumer.id,
					score      : consumer.score
				})
				.catch(() => {});
		}
		catch (error)
		{
			logger.warn('_createConsumer() | failed:%o', error);
		}
	}
}

module.exports = Room;
