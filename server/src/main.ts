import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, SERVER_VERSION } from './app.ts';
import { openDb } from './db.ts';

const root = process.env.PARTYMIX_ROOT ?? '/PartyMix';
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
const allowPublic = process.env.PARTYMIX_ALLOW_PUBLIC === '1';

mkdirSync(join(root, 'database'), { recursive: true });
const db = await openDb(join(root, 'database', 'partymix.sqlite'));
const app = createApp({ root, allowPublic, db });
const server = createServer(app.handle);
server.listen(port, host, () => {
  console.log(`PartyMix server ${SERVER_VERSION} (${db.engine}, Node ${process.version}) su http://${host}:${port}, cartella ${root}${allowPublic ? ' (ATTENZIONE: accesso da internet consentito)' : ''}`);
});

const stop = () => {
  server.close();
  app.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
