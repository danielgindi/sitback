async function someAsync(array, fun, thisArg) {
    const t = Object(array);
    const len = t.length >>> 0;

    for (let i = 0; i < len; i++) {
        if (i in t && await fun.call(thisArg, t[i], i, t)) {
            return true;
        }
    }

    return false;
}

export default someAsync;
