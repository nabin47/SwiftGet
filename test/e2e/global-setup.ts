import { startTestServer } from '../server/server.ts';

export default async function globalSetup() {
  const server = await startTestServer();
  process.env.TEST_SERVER_URL = server.url;
  return () => server.close();
}
