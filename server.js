'use strict';
const path = require('node:path');
const { createGameServer, networkUrls } = require('./src/httpServer');
const game = createGameServer({
  storageFile: process.env.GANG_DATA_FILE || path.join(__dirname, 'data', 'rooms.json'),
  databaseFile: process.env.GANG_DATABASE_FILE || process.env.GANG_DB_FILE || path.join(__dirname, 'data', 'chill-and-thrill.sqlite'),
});
const port = Number(process.env.PORT) || 3000;
game.server.listen(port, '0.0.0.0', () => {
  console.log(`\n${process.env.GANG_PORTAL_NAME || 'Chill & Thrill'} · LAN`);
  for (const address of networkUrls(port)) console.log(`${address.name}: ${address.url}`);
  console.log('Quét QR trong phòng chờ để mời bạn bè.\n');
});
game.server.on('error', error => { console.error(`Không khởi động được máy chủ: ${error.message}`); game.gm.close(); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => game.close().then(() => process.exit(0)));
