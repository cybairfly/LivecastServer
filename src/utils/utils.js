module.exports = {
    addTimeoutToPromise: (promise, timeoutMillis, errorMessage) => {
        return new Promise((resolve, reject) => {
            // ow(promise, ow.promise);
            // ow(timeoutMillis, ow.number);
            // ow(errorMessage, ow.string);
            const timeout = setTimeout(() => reject(new Error(errorMessage)), timeoutMillis);
            promise
                .then(resolve)
                .catch(reject)
                .finally(() => clearTimeout(timeout));
        });
    },
};
