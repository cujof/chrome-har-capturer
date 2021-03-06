'use strict';

const Context = require('./context');
const Stats = require('./stats');

const fs = require('fs');
const viewportWidth = 1200;
const viewportHight = 900;
const format = 'png';

class Timer {
    constructor(milliseconds) {
        this._milliseconds = milliseconds;
    }

    start() {
        this.cancel();
        return new Promise((fulfill, reject) => {
            if (typeof this._milliseconds === 'undefined') {
                // wait indefinitely
                return;
            }
            this._id = setTimeout(fulfill, this._milliseconds);
        });
    }

    cancel() {
        clearTimeout(this._id);
    }
}

class Live {
    constructor({url, index, urls, options}) {
        this._url = url;
        this._index = index;
        this._urls = urls;
        this._options = options;
    }

    async load() {
        // create a fresh new context for this URL
        const context = new Context(this._options);
        const client = await context.create();
        // hooks
        const {preHook, postHook} = this._options;
        const hookArgs = [this._url, client, this._index, this._urls];
        // optionally run the user-defined hook
        if (typeof preHook === 'function') {
            await preHook.apply(null, hookArgs);
        }
        // create (but not start) the page timer
        const timer = new Timer(this._options.timeout);
        // handle proper page load and postHook or related errors
        const pageLoad = async () => {
            try {
                // start the page load and waits for its termination
                const stats = await this._loadPage(client, postHook, hookArgs);
                return stats;
            } finally {
                // no-matter-what cleanup functions
                await context.destroy();
                timer.cancel();
            }
        };
        // handle Chrome disconnection
        const disconnection = async () => {
            await new Promise((fulfill, reject) => {
                client.once('disconnect', fulfill);
            });
            timer.cancel();
            throw new Error('Disconnected');
        };
        // handle page timeout
        const timeout = async () => {
            await timer.start();
            await context.destroy();
            throw new Error('Timed out');
        };
        // wait for the first event to happen
        return await Promise.race([
            pageLoad(),
            disconnection(),
            timeout()
        ]);
    }

    async _loadPage(client, postHook, hookArgs) {
        // enable domains
        const {Page, Network} = client;
        await Network.enable();
        await Page.enable();
        // register events
        const stats = new Stats(this._url, this._options);
        const termination = new Promise((fulfill, reject) => {
            client.on('event', (event) => {
                stats.processEvent(fulfill, reject, event);
            });
            // XXX the separation of concerns between live fetching and HAR
            // computation made it necessary to introduce a synthetic event
            // which is the reply of the Network.getResponseBody method
            if (this._options.content) {
                Network.loadingFinished(async ({requestId}) => {
                    // only for those entries that are being tracked (e.g., not
                    // for cached items)
                    if (!stats.entries.get(requestId)) {
                        return;
                    }
                    try {
                        const params = await Network.getResponseBody({requestId});
                        const {body, base64Encoded} = params;
                        stats.processEvent(fulfill, reject, {
                            method: 'Network.getResponseBody',
                            params: {
                                requestId,
                                body,
                                base64Encoded
                            }
                        });
                    } catch (err) {
                        reject(err);
                    }
                });
            }
        });
        // start the page load
        const navigation = Page.navigate({url: this._url});
        // events will determine termination
        await Promise.all([termination, navigation]);
        // optionally run the user-defined hook
        if (typeof postHook === 'function') {
            stats.user = await postHook.apply(null, hookArgs);
        }
        // save screenshot if requested
        if (this._options.screenshot) {
          console.log('screeee');
            const {Emulation} = client;
            const deviceMetrics = {
                width: viewportWidth,
                height: viewportHight,
                deviceScaleFactor: 1,
                mobile: false,
                fitWindow: true,
            };
            await Emulation.setDeviceMetricsOverride(deviceMetrics);
            await Emulation.setVisibleSize({width: viewportWidth, height: viewportHight});
            const {data} = await Page.captureScreenshot({format});
            const filename = this._url.replace(/[\W_]+/g,"_") + '.png';
            fs.writeFileSync(filename, Buffer.from(data, 'base64'));
        }
        return stats;
    }
}

module.exports = Live;
