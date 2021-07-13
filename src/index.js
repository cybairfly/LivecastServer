const Apify = require('apify');

const http = require('http');
const fs = require('fs-extra');
const path = require('path');
const { promisify } = require('util');
const express = require('express');
const socketio = require('socket.io');
const { promisifyServerListen } = require('apify-shared/utilities');
const { ENV_VARS, LOCAL_ENV_VARS } = require('apify-shared/consts');
const { Page } = require('puppeteer'); // eslint-disable-line no-unused-vars
const { addTimeoutToPromise } = require('./utils/utils');
const Snapshot = require('./snapshot');

const { log: defaultLog } = Apify.utils;

const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const ensureDir = promisify(fs.ensureDir);

const LOCAL_STORAGE_DIR = process.env[ENV_VARS.LOCAL_STORAGE_DIR] || '';
const DEFAULT_SCREENSHOT_DIR_PATH = path.resolve(LOCAL_STORAGE_DIR, 'live_view');

/**
 * `LivecastServer` enables serving of browser snapshots via web sockets. It includes its own client
 * that provides a simple frontend to viewing the captured snapshots. A snapshot consists of three
 * pieces of information, the currently opened URL, the content of the page (HTML) and its screenshot.
 *
 * ```json
 * {
 *     "pageUrl": "https://www.example.com",
 *     "htmlContent": "<html><body> ....",
 *     "screenshotIndex": 3,
 *     "createdAt": "2019-04-18T11:50:40.060Z"
 * }
 * ```
 *
 * `LivecastServer` is useful when you want to be able to inspect the current browser status on demand.
 * When no client is connected, the webserver consumes very low resources so it should have a close
 * to zero impact on performance. Only once a client connects the server will start serving snapshots.
 * Once no longer needed, it can be disabled again in the client to remove any performance impact.
 *
 * NOTE: Screenshot taking in browser typically takes around 300ms. So having the `LivecastServer`
 * always serve snapshots will have a significant impact on performance.
 *
 * It will take snapshots of the first page of the latest browser. Taking snapshots of only a
 * single page improves performance and stability dramatically in high concurrency situations.
 *
 * When running locally, it is often best to use a headful browser for debugging, since it provides
 * a better view into the browser, including DevTools, but `LivecastServer` works too.
 * @ignore
 */
class LivecastServer {
    /**
     * @param {Object} [options]
     *   All `LivecastServer` parameters are passed
     *   via an options object with the following keys:
     * @param {string} [options.screenshotDirectoryPath]
     *   By default, the screenshots are saved to
     *   the `live_view` directory in the Apify local storage directory.
     *   Provide a different absolute path to change the settings.
     * @param {number} [options.maxScreenshotFiles=10]
     *   Limits the number of screenshots stored
     *   by the server. This is to prevent using up too much disk space.
     * @param {number} [options.snapshotTimeoutSecs=3]
     *   If a snapshot is not made within the timeout,
     *   its creation will be aborted. This is to prevent
     *   pages from being hung up by a stalled screenshot.
     * @param {number} [options.maxSnapshotFrequencySecs=2]
     *   Use this parameter to further decrease the resource consumption
     *   of `LivecastServer` by limiting the frequency at which it'll
     *   serve snapshots.
     */
    constructor(options = {}) {
        const {
            screenshotDirectoryPath = DEFAULT_SCREENSHOT_DIR_PATH,
            maxScreenshotFiles = 10,
            snapshotTimeoutSecs = 3,
            maxSnapshotFrequencySecs = 2,
            useScreenshots = false,
            promptHandlers = {},
        } = options;

        this.log = defaultLog.child({ prefix: 'LivecastServer' });
        this.screenshotDirectoryPath = screenshotDirectoryPath;
        this.maxScreenshotFiles = maxScreenshotFiles;
        this.snapshotTimeoutMillis = snapshotTimeoutSecs * 1000;
        this.maxSnapshotFrequencyMillis = maxSnapshotFrequencySecs * 1000;
        this.useScreenshots = useScreenshots;
        this.promptHandlers = promptHandlers;

        /**
         * @type {?Snapshot}
         * @private
         */
        this.lastSnapshot = null;
        this.lastScreenshotIndex = 0;

        // Server
        this.clientCount = 0;
        this._isRunning = false;
        this.httpServer = null;
        this.socketio = null;
        this.servingSnapshot = false;

        this._setupHttpServer();
    }

    async prompt(options = {}) {
        const response = await new Promise((resolve) => {
            this.resolveMessagePromise = resolve;
            this.send('prompt', options)
                .then(() => this.log.debug('Waiting for frontend prompt response'));
        });
        this.log.debug('Response data.', { response });
        this.handleResponse(response);
    }

    handleResponse(response) {
        if (!this.promptHandlers[response.action]) {
            this.log.warning('No handler for response action', response);
            return;
        }
        return this.promptHandlers[response.action](response);
    }

    /**
     * Starts the HTTP server with web socket connections enabled.
     * Snapshots will not be created until a client has connected.
     * @return {Promise<void>}
     */
    async start() {
        this._isRunning = true;
        try {
            await ensureDir(this.screenshotDirectoryPath);
            await promisifyServerListen(this.httpServer)(this.port);
            this.log.info('Live view web server started', { publicUrl: this.liveViewUrl });
        } catch (err) {
            this.log.exception(err, 'Live view web server failed to start.');
            this._isRunning = false;
        }
    }

    /**
     * Prevents the server from receiving more connections. Existing connections
     * will not be terminated, but the server will not prevent a process exit.
     * @return {Promise<void>}
     */
    async stop() {
        this.httpServer.unref();
        return new Promise((resolve) => {
            this.httpServer.close((err) => {
                this._isRunning = false;
                if (err) this.log.exception(err, 'Live view web server could not be stopped.');
                else this.log.info('Live view web server stopped.');
                resolve();
            });
        });
    }

    /**
     * Serves a snapshot to all connected clients.
     * Screenshots are not served directly, only their index number
     * which is used by client to retrieve the screenshot.
     *
     * Will time out and throw in `options.snapshotTimeoutSecs`.
     *
     * @param {Page} page
     * @return {Promise<void>}
     */
    async serve(page) {
        if (!this.hasClients()) {
            this.log.debug('Live view server has no clients, skipping snapshot.');
            return;
        }
        // Only serve one snapshot at a time because Puppeteer
        // can't make screenshots in parallel.
        if (this.servingSnapshot) {
            this.log.debug('Already serving a snapshot, not starting a new one.');
            return;
        }

        if (this.lastSnapshot && this.lastSnapshot.age() < this.maxSnapshotFrequencyMillis) {
            this.log.debug(`Snapshot was already served in less than ${this.maxSnapshotFrequencyMillis}ms.`);
            return;
        }

        try {
            this.servingSnapshot = true;
            const snapshot = await addTimeoutToPromise(
                this._makeSnapshot(page),
                this.snapshotTimeoutMillis,
                'LivecastServer: Serving of Live View timed out.',
            );
            this._pushSnapshot(snapshot);
        } catch (err) {
            this.log.exception(err, 'Serving of page for live view failed');
        } finally {
            this.servingSnapshot = false;
        }
    }

    /**
     * @return {boolean}
     */
    isRunning() {
        return this._isRunning;
    }

    /**
     * @return {boolean}
     */
    hasClients() {
        // Treat LivecastServer as a client, until at least one snapshot is made.
        return this.lastSnapshot ? this.clientCount > 0 : true;
    }

    async send(message, data) {
        this.log.debug('Sending websocket message', { message });
        this.socketio.emit(message, data);
    }

    /**
     * Returns an absolute path to the screenshot with the given index.
     * @param {number} screenshotIndex
     * @return {string}
     * @private
     */
    _getScreenshotPath(screenshotIndex) {
        return path.join(this.screenshotDirectoryPath, `${screenshotIndex}.jpeg`);
    }

    /**
     * @param {Page} page
     * @return {Promise<Snapshot>}
     * @private
     */
    async _makeSnapshot(page) {
        const pageUrl = page.url();
        this.log.info('Making live view snapshot.', { pageUrl });
        const [htmlContent, screenshot] = await Promise.all([
            page.content(),
            this.useScreenshots ? page.screenshot({
                type: 'jpeg',
                quality: 75,
            }) : null,
        ]);

        const screenshotIndex = this.useScreenshots ? this.lastScreenshotIndex++ : null;

        if (screenshot) {
            await writeFile(this._getScreenshotPath(screenshotIndex), screenshot);
            if (screenshotIndex > this.maxScreenshotFiles - 1) {
                this._deleteScreenshot(screenshotIndex - this.maxScreenshotFiles);
            }
        }

        const snapshot = new Snapshot({ pageUrl, htmlContent, screenshotIndex });
        this.lastSnapshot = snapshot;
        return snapshot;
    }

    /**
     * @param {Snapshot} snapshot
     * @private
     */
    _pushSnapshot(snapshot) {
        // Send new snapshot to clients
        this.log.debug('Sending live view snapshot', { createdAt: snapshot.createdAt, pageUrl: snapshot.pageUrl });
        this.send('snapshot', snapshot);
    }

    /**
     * Initiates an async delete and does not wait for it to complete.
     * @param {number} screenshotIndex
     * @private
     */
    _deleteScreenshot(screenshotIndex) {
        unlink(this._getScreenshotPath(screenshotIndex))
            .catch((err) => this.log.exception(err, 'Cannot delete live view screenshot.'));
    }

    _setupHttpServer() {
        const containerPort = process.env[ENV_VARS.CONTAINER_PORT] || LOCAL_ENV_VARS[ENV_VARS.CONTAINER_PORT];

        this.port = parseInt(containerPort, 10);
        if (!(this.port >= 0 && this.port <= 65535)) {
            throw new Error('Cannot start LivecastServer - invalid port specified by the '
                + `${ENV_VARS.CONTAINER_PORT} environment variable (was "${containerPort}").`);
        }
        this.liveViewUrl = process.env[ENV_VARS.CONTAINER_URL] || LOCAL_ENV_VARS[ENV_VARS.CONTAINER_URL];

        this.httpServer = http.createServer();
        const app = express();

        app.use('/', express.static(path.join(__dirname, '../public')));

        // Serves JPEG with the last screenshot
        app.get('/screenshot/:index', (req, res) => {
            const screenshotIndex = req.params.index;
            const filePath = this._getScreenshotPath(screenshotIndex);
            res.sendFile(filePath);
        });

        app.all('*', (req, res) => {
            res.status(404).send('Nothing here');
        });

        this.httpServer.on('request', app);

        // Socket.io server used to send snapshots to client
        this.socketio = socketio(this.httpServer);
        this.socketio.on('connection', this._socketConnectionHandler.bind(this));
    }

    /**
     * @param {socketio.Socket} socketPrompt
     * @private
     */
    _socketConnectionHandler(socket) {
        this.clientCount++;
        this.log.info('Live view client connected', { clientId: socket.id });
        socket.on('disconnect', (reason) => {
            this.clientCount--;
            this.log.info('Live view client disconnected', { clientId: socket.id, reason });
        });
        socket.on('promptAnswer', (data) => {
            this.log.debug('promptAnswer', data);

            try {
                data = JSON.parse(`${data}`);
            } catch (error) {
                this.log.debug('Failed to parse incoming message data', data);
            }

            this.resolveMessagePromise(data);
        });

        socket.on('getLastSnapshot', () => {
            if (this.lastSnapshot) {
                this.log.debug('Sending live view snapshot', { createdAt: this.lastSnapshot.createdAt, pageUrl: this.lastSnapshot.pageUrl });
                this.send('snapshot', this.lastSnapshot);
            }
        });
    }
}

module.exports = LivecastServer;
