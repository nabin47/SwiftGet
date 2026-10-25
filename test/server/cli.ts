import { startTestServer } from './server.ts';

const port = Number(process.env.PORT ?? 8787);
const server = await startTestServer(port, process.env.HOST ?? '127.0.0.1');
console.log(`SwiftGet test server listening on ${server.url}`);
