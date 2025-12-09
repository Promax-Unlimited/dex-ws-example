import { DexWebSocketClient } from './wsClient.js';

const token = process.env.DEX_TOKEN;

if (!token) {
  console.error('Please set DEX_TOKEN in your environment before running this script.');
  process.exit(1);
}

let baseUrl = process.env.DEX_BASE_URL;

if (!baseUrl) {
  console.error('Please set DEX_BASE_URL in your environment before running this script.');
  process.exit(1);
}

baseUrl = "ws://" + baseUrl + "/v1/ws";

const client = new DexWebSocketClient({
  baseUrl,
  token,
  // isStream: true,
  onOpen: () => {
    console.log('Connected.\n');
    // Data transfer begins only when the client explicitly requests it after the connection is established
    client.send({});
  },
  onMessage: (message) => {
    console.log(JSON.stringify(message, null, 2));
  },
  onError: (error) => {
    console.error('WebSocket response:', error.message);
  },
  onClose: (code, reason) => {
    console.log(`Connection closed (code=${code}, reason=${reason.toString() || 'n/a'})`);
  },
});

client.connect();

process.on('SIGINT', () => {
  client.close();
  process.exit(0);
});
