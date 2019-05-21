const net = require('net');
const Logger = require('./Logger');

const logger = new Logger('LPZ Interactive Client');

const SOCKET_PATH = '/tmp/mediasoup-demo.sock';

module.exports = async function()
{
	logger.debug('connect socket enter');
	const socket = net.connect(SOCKET_PATH);

	process.stdin.pipe(socket);
	socket.pipe(process.stdout);

	socket.on('connect', () => process.stdin.setRawMode(true));
	socket.on('close', () => process.exit(0));
	socket.on('exit', () => socket.end());
	logger.debug('connect socket exit');
};
