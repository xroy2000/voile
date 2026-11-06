export class Sim {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SimFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sim_free(ptr, 0);
    }
    /**
     * État de la partie (temps, bateau, adversaires, trace) en JSON, pour la sauvegarde.
     * Le pilote et la route sont sauvegardés côté JavaScript (`pilot_target`, route du routeur).
     * @returns {string}
     */
    export_state() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sim_export_state(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {boolean}
     */
    follow_route() {
        const ret = wasm.sim_follow_route(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Restaure un état produit par `export_state` sur la même partie (même parcours, même vent).
     * @param {string} json
     */
    import_state(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sim_import_state(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {string}
     */
    info() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sim_info(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * `wind_bin` : fichier VWN1 produit par `gribtool` (absent = vent synthétique).
     * `land_geojson` : polygones de terre (absent = pas de côtes). `polar_text` : CSV/.pol (absent = polaire générique).
     * `now_unix` : instant de départ souhaité (ramené dans la plage de la prévision).
     * @param {Uint8Array | number[] | null | undefined} wind_bin
     * @param {string | null | undefined} land_geojson
     * @param {string | null | undefined} polar_text
     * @param {number} now_unix
     */
    constructor(wind_bin, land_geojson, polar_text, now_unix) {
        const val4 = +now_unix;
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = isLikeNone(wind_bin) ? 0 : passArray8ToWasm0(wind_bin, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = isLikeNone(land_geojson) ? 0 : passStringToWasm0(land_geojson, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = isLikeNone(polar_text) ? 0 : passStringToWasm0(polar_text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.sim_new(ptr0, len0, ptr1, len1, ptr2, len2, val4);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        SimFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Mode du pilote : [type, a, b] — 0 cap (a = cap), 1 TWA (a = TWA signé), 2 VMG près, 3 VMG portant,
     * 4 vers un point (a, b = lat, lon), 5 route du routeur.
     * @returns {Float64Array}
     */
    pilot_target() {
        const ret = wasm.sim_pilot_target(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @param {number} tws
     * @returns {Float64Array}
     */
    polar_best_angles(tws) {
        const ret = wasm.sim_polar_best_angles(this.__wbg_ptr, tws);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Vitesse du bateau pour TWA = 0, 2, …, 180° au vent `tws` : pour tracer le diagramme polaire.
     * @param {number} tws
     * @returns {Float64Array}
     */
    polar_curve(tws) {
        const ret = wasm.sim_polar_curve(this.__wbg_ptr, tws);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Repart de zéro sur un nouveau parcours (départ = ta position réelle dans le jeu, par exemple).
     * @param {number} start_lat
     * @param {number} start_lon
     * @param {number} finish_lat
     * @param {number} finish_lon
     * @param {number} start_unix
     */
    reset(start_lat, start_lon, finish_lat, finish_lon, start_unix) {
        wasm.sim_reset(this.__wbg_ptr, start_lat, start_lon, finish_lat, finish_lon, start_unix);
    }
    /**
     * Route calculée depuis un point et un instant quelconques, sans toucher à la partie en cours
     * (c'est ce qu'appelle le worker). `quality` : 0 rapide, 1 standard, 2 précis.
     * @param {number} lat
     * @param {number} lon
     * @param {number} t0
     * @param {number} quality
     * @returns {string}
     */
    route_from(lat, lon, t0, quality) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sim_route_from(this.__wbg_ptr, lat, lon, t0, quality);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Comme `route_from` mais vers un point d'arrivée quelconque (point de routage intermédiaire).
     * @param {number} lat
     * @param {number} lon
     * @param {number} t0
     * @param {number} quality
     * @param {number} dest_lat
     * @param {number} dest_lon
     * @returns {string}
     */
    route_leg(lat, lon, t0, quality, dest_lat, dest_lon) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sim_route_leg(this.__wbg_ptr, lat, lon, t0, quality, dest_lat, dest_lon);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Les bateaux adverses suivent cette route (format `to_flat`).
     * @param {Float64Array | number[]} flat
     * @returns {boolean}
     */
    set_ai_route_flat(flat) {
        const ptr0 = passArrayF64ToWasm0(flat, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sim_set_ai_route_flat(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * @param {number} h
     */
    set_heading(h) {
        wasm.sim_set_heading(this.__wbg_ptr, h);
    }
    /**
     * @param {string} text
     */
    set_polar(text) {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sim_set_polar(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Mémorise une route (format `to_flat`) pour que le pilote puisse la suivre.
     * @param {Float64Array | number[]} flat
     * @returns {boolean}
     */
    set_route_flat(flat) {
        const ptr0 = passArrayF64ToWasm0(flat, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sim_set_route_flat(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * TWA signé : positif = vent par tribord.
     * @param {number} a
     */
    set_twa(a) {
        wasm.sim_set_twa(this.__wbg_ptr, a);
    }
    /**
     * @param {boolean} upwind
     */
    set_vmg(upwind) {
        wasm.sim_set_vmg(this.__wbg_ptr, upwind);
    }
    /**
     * @param {number} lat
     * @param {number} lon
     */
    set_waypoint(lat, lon) {
        wasm.sim_set_waypoint(this.__wbg_ptr, lat, lon);
    }
    set_waypoint_finish() {
        wasm.sim_set_waypoint_finish(this.__wbg_ptr);
    }
    /**
     * @returns {string}
     */
    snapshot() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sim_snapshot(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} sim_dt
     */
    tick(sim_dt) {
        wasm.sim_tick(this.__wbg_ptr, sim_dt);
    }
    /**
     * [tws, twd] à un point, à l'instant courant plus `dh` heures.
     * @param {number} lat
     * @param {number} lon
     * @param {number} dh
     * @returns {Float64Array}
     */
    wind_at(lat, lon, dh) {
        const ret = wasm.sim_wind_at(this.__wbg_ptr, lat, lon, dh);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Vent en plusieurs points : entrée [lat, lon, lat, lon, …], sortie [u, v, u, v, …] (nds), à l'instant courant.
     * @param {Float64Array | number[]} coords
     * @returns {Float32Array}
     */
    wind_at_many(coords) {
        const ptr0 = passArrayF64ToWasm0(coords, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sim_wind_at_many(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * Vent échantillonné [u, v, u, v, …] (nds), lignes du sud au nord, à l'instant courant du jeu.
     * @param {number} lat0
     * @param {number} lon0
     * @param {number} lat1
     * @param {number} lon1
     * @param {number} nx
     * @param {number} ny
     * @returns {Float32Array}
     */
    wind_grid(lat0, lon0, lat1, lon1, nx, ny) {
        const ret = wasm.sim_wind_grid(this.__wbg_ptr, lat0, lon0, lat1, lon1, nx, ny);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) Sim.prototype[Symbol.dispose] = Sim.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_208446807d0d1e30: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_757e9472f8410341: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_bb74001155cb8ca8: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_stack_575c4e0918581b9c: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./regatta_web_bg.js": import0,
    };
}

const SimFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sim_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
    numBytesDecoded += bytes.length;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
        cachedTextDecoder.decode();
        numBytesDecoded = bytes.length;
    }
    return cachedTextDecoder.decode(bytes);
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('regatta_web_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
