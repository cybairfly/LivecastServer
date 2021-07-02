const Apify = require('apify');
const Server = require('./lib/index');

const { sleep } = Apify.utils;

Apify.main(async () => {
    const server = new Server();
    console.log(server);
    await new Promise(() => {});
    // await sleep(99999);
});
