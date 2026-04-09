const ADB_CLASS = 0xff;
const ADB_SUBCLASS = 0x42;
const ADB_PROTOCOL = 0x01;

export const ADB_COMMANDS = {
  AUTH: 0x48545541,
  CLSE: 0x45534c43,
  CNXN: 0x4e584e43,
  OKAY: 0x59414b4f,
  OPEN: 0x4e45504f,
  WRTE: 0x45545257,
};

export const ADB_AUTH_TYPES = {
  TOKEN: 1,
  SIGNATURE: 2,
  RSAPUBLICKEY: 3,
};

const ADB_VERSION = 0x01000001;
const ADB_MAX_DATA = 1024 * 1024;
const KEY_STORAGE = 'rktool-webusb:adb-keypair:v1';

function getGlobalCrypto() {
  if (globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }
  throw new Error('当前环境不支持 WebCrypto，无法使用 Web ADB');
}

function encodeAsciiCommand(text) {
  return (
    text.charCodeAt(0)
    | (text.charCodeAt(1) << 8)
    | (text.charCodeAt(2) << 16)
    | (text.charCodeAt(3) << 24)
  ) >>> 0;
}

function decodeAsciiCommand(value) {
  return String.fromCharCode(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

function checksum(payload) {
  let sum = 0;
  for (const byte of payload) {
    sum = (sum + byte) >>> 0;
  }
  return sum >>> 0;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function utf8Encode(text) {
  return new TextEncoder().encode(text);
}

function utf8Decode(bytes) {
  return new TextDecoder().decode(bytes);
}

function uint32ToBytes(value) {
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint32(0, value >>> 0, true);
  return out;
}

function bytesToBigIntLE(bytes) {
  let result = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    result = (result << 8n) | BigInt(bytes[index]);
  }
  return result;
}

function bigIntToFixedLE(value, size) {
  let rest = value;
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function modInverse(a, m) {
  let t = 0n;
  let newT = 1n;
  let r = m;
  let newR = ((a % m) + m) % m;

  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }

  if (r !== 1n) {
    throw new Error('无法计算模逆');
  }

  if (t < 0n) {
    t += m;
  }
  return t;
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let power = base % modulus;
  let exp = exponent;
  while (exp > 0n) {
    if ((exp & 1n) === 1n) {
      result = (result * power) % modulus;
    }
    power = (power * power) % modulus;
    exp >>= 1n;
  }
  return result;
}

function base64Encode(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64UrlToBytes(text) {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = `${normalized}${'='.repeat(padLength)}`;
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function encodeAdbPacket(command, arg0 = 0, arg1 = 0, payload = new Uint8Array()) {
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const header = new Uint8Array(24);
  const view = new DataView(header.buffer);
  view.setUint32(0, command >>> 0, true);
  view.setUint32(4, arg0 >>> 0, true);
  view.setUint32(8, arg1 >>> 0, true);
  view.setUint32(12, body.length >>> 0, true);
  view.setUint32(16, checksum(body), true);
  view.setUint32(20, (command ^ 0xffffffff) >>> 0, true);
  return concatBytes([header, body]);
}

export function decodeAdbHeader(bytes) {
  const view = bytes instanceof DataView
    ? bytes
    : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const command = view.getUint32(0, true);
  return {
    command,
    commandName: decodeAsciiCommand(command),
    arg0: view.getUint32(4, true),
    arg1: view.getUint32(8, true),
    payloadLength: view.getUint32(12, true),
    payloadChecksum: view.getUint32(16, true),
    magic: view.getUint32(20, true),
  };
}

export function findAdbInterface(device) {
  const configurations = device.configurations || (device.configuration ? [device.configuration] : []);
  for (const configuration of configurations) {
    for (const iface of configuration.interfaces || []) {
      for (const alternate of iface.alternates || []) {
        if (
          alternate.interfaceClass !== ADB_CLASS
          || alternate.interfaceSubclass !== ADB_SUBCLASS
          || alternate.interfaceProtocol !== ADB_PROTOCOL
        ) {
          continue;
        }
        const inEndpoint = alternate.endpoints?.find((endpoint) => endpoint.direction === 'in' && endpoint.type === 'bulk');
        const outEndpoint = alternate.endpoints?.find((endpoint) => endpoint.direction === 'out' && endpoint.type === 'bulk');
        if (inEndpoint && outEndpoint) {
          return {
            configurationValue: configuration.configurationValue,
            interfaceNumber: iface.interfaceNumber,
            alternateSetting: alternate.alternateSetting,
            inEndpoint: inEndpoint.endpointNumber,
            outEndpoint: outEndpoint.endpointNumber,
            packetSize: inEndpoint.packetSize || 16384,
          };
        }
      }
    }
  }
  throw new Error('未找到可用的 ADB WebUSB 接口');
}

export async function buildAdbPublicKeyPayloadFromJwk(jwk, comment = 'webusb@rktool') {
  const modulusBytes = base64UrlToBytes(jwk.n);
  const exponentBytes = base64UrlToBytes(jwk.e);
  const modulus = bytesToBigIntLE(Uint8Array.from(modulusBytes).reverse());
  const exponent = bytesToBigIntLE(Uint8Array.from(exponentBytes).reverse());
  const modulusWordCount = 64;
  const modulusSize = modulusWordCount * 4;
  const modulusLe = bigIntToFixedLE(modulus, modulusSize);
  const rr = modPow(2n, BigInt(modulusSize * 16), modulus);
  const rrLe = bigIntToFixedLE(rr, modulusSize);
  const two32 = 1n << 32n;
  const n0inv = Number((two32 - modInverse(modulus & (two32 - 1n), two32)) & (two32 - 1n));
  const body = concatBytes([
    uint32ToBytes(modulusWordCount),
    uint32ToBytes(n0inv),
    modulusLe,
    rrLe,
    uint32ToBytes(Number(exponent)),
  ]);
  const encoded = base64Encode(body);
  return utf8Encode(`${encoded} ${comment}\0`);
}

async function importStoredKeyPair(storage, cryptoImpl) {
  if (!storage?.getItem) {
    return null;
  }
  const raw = storage.getItem(KEY_STORAGE);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const subtle = cryptoImpl.subtle;
    const publicKey = await subtle.importKey(
      'jwk',
      parsed.publicKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
      true,
      ['verify'],
    );
    const privateKey = await subtle.importKey(
      'jwk',
      parsed.privateKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
      true,
      ['sign'],
    );
    return { publicKey, privateKey, source: 'stored' };
  } catch (_error) {
    storage.removeItem(KEY_STORAGE);
    return null;
  }
}

async function createKeyPair(storage, cryptoImpl) {
  const subtle = cryptoImpl.subtle;
  const keyPair = await subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-1',
    },
    true,
    ['sign', 'verify'],
  );
  if (storage?.setItem) {
    try {
      const [publicKey, privateKey] = await Promise.all([
        subtle.exportKey('jwk', keyPair.publicKey),
        subtle.exportKey('jwk', keyPair.privateKey),
      ]);
      storage.setItem(KEY_STORAGE, JSON.stringify({ publicKey, privateKey }));
    } catch (_error) {
    }
  }
  return { ...keyPair, source: 'generated' };
}

export class WebAdbSession {
  constructor(options = {}) {
    if (!options.device) {
      throw new Error('device is required');
    }
    this.device = options.device;
    this.logger = typeof options.onLog === 'function' ? options.onLog : () => {};
    this.storage = options.storage ?? globalThis.localStorage ?? null;
    this.crypto = options.crypto ?? getGlobalCrypto();
    this.usb = options.usb ?? globalThis.navigator?.usb ?? null;
    this.keyComment = options.keyComment || 'webusb@rktool';
    this.interfaceInfo = null;
    this.connected = false;
    this.closed = false;
    this.closing = false;
    this.readLoopPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.streamId = 1;
    this.streams = new Map();
    this.keyPair = null;
    this.publicKeyPayload = null;
    this.authSentPublicKey = false;
    this.authTriedSignature = false;
    this.readBuffer = new Uint8Array(0);
  }

  static async requestDevice(usb = globalThis.navigator?.usb) {
    if (!usb?.requestDevice) {
      throw new Error('当前浏览器不支持 WebUSB ADB');
    }
    return usb.requestDevice({
      filters: [{
        classCode: ADB_CLASS,
        subclassCode: ADB_SUBCLASS,
        protocolCode: ADB_PROTOCOL,
      }],
    });
  }

  async ensureKeyMaterial() {
    if (this.keyPair) {
      return this.keyPair;
    }
    this.keyPair = await importStoredKeyPair(this.storage, this.crypto);
    if (!this.keyPair) {
      this.keyPair = await createKeyPair(this.storage, this.crypto);
    }
    const jwk = await this.crypto.subtle.exportKey('jwk', this.keyPair.publicKey);
    this.publicKeyPayload = await buildAdbPublicKeyPayloadFromJwk(jwk, this.keyComment);
    return this.keyPair;
  }

  async connect() {
    this.closed = false;
    this.closing = false;
    this.connected = false;
    this.readBuffer = new Uint8Array(0);
    this.authSentPublicKey = false;
    this.authTriedSignature = false;
    this.connectResolve = null;
    this.connectReject = null;
    this.interfaceInfo = findAdbInterface(this.device);
    if (!this.device.opened) {
      await this.device.open();
    }
    if (this.device.configuration?.configurationValue !== this.interfaceInfo.configurationValue) {
      await this.device.selectConfiguration(this.interfaceInfo.configurationValue);
    }
    await this.device.claimInterface(this.interfaceInfo.interfaceNumber);
    if (
      this.device.configuration?.interfaces
        ?.find((entry) => entry.interfaceNumber === this.interfaceInfo.interfaceNumber)
        ?.alternate?.alternateSetting !== this.interfaceInfo.alternateSetting
    ) {
      await this.device.selectAlternateInterface(this.interfaceInfo.interfaceNumber, this.interfaceInfo.alternateSetting);
    }
    this.readLoopPromise = this.readLoop();
    await this.sendPacket(ADB_COMMANDS.CNXN, ADB_VERSION, ADB_MAX_DATA, utf8Encode('host::rktool-webusb\0'));
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('ADB 连接超时'));
      }, 15000);
      this.connectResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.connectReject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
    });
    return this;
  }

  async close() {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.closed = true;
    this.connected = false;
    this.connectResolve = null;
    this.connectReject = null;
    for (const stream of this.streams.values()) {
      stream.reject(new Error('ADB 会话已关闭'));
    }
    this.streams.clear();
    try {
      if (this.device.opened && this.interfaceInfo) {
        await this.device.releaseInterface(this.interfaceInfo.interfaceNumber);
      }
    } catch (_error) {
    }
    try {
      if (this.device.opened) {
        await this.device.close();
      }
    } catch (_error) {
    }
    this.readLoopPromise = null;
    this.readBuffer = new Uint8Array(0);
    this.closing = false;
  }

  async sendPacket(command, arg0 = 0, arg1 = 0, payload = new Uint8Array()) {
    const packet = encodeAdbPacket(command, arg0, arg1, payload);
    const result = await this.device.transferOut(this.interfaceInfo.outEndpoint, packet);
    if (result.status !== 'ok') {
      throw new Error(`ADB 写入失败: ${result.status || 'unknown'}`);
    }
  }

  async readPacket() {
    const headerBytes = await this.readBytes(24);
    const header = decodeAdbHeader(headerBytes);
    if (header.magic !== ((header.command ^ 0xffffffff) >>> 0)) {
      throw new Error('ADB 头部校验失败');
    }
    const payload = header.payloadLength > 0
      ? await this.readBytes(header.payloadLength)
      : new Uint8Array(0);
    const actualChecksum = checksum(payload);
    if (header.payloadChecksum !== 0 && actualChecksum !== header.payloadChecksum) {
      throw new Error(`ADB 数据校验失败: cmd=${header.commandName} len=${header.payloadLength} expected=${header.payloadChecksum} actual=${actualChecksum}`);
    }
    return { header, payload };
  }

  async readChunk() {
    const result = await this.device.transferIn(this.interfaceInfo.inEndpoint, this.interfaceInfo?.packetSize || 512);
    if (result.status !== 'ok' || !result.data) {
      throw new Error(`ADB 读取失败: ${result.status || 'unknown'}`);
    }
    const chunk = new Uint8Array(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength,
    );
    if (chunk.length === 0) {
      throw new Error('ADB 读取到空数据包');
    }
    return chunk;
  }

  async readBytes(length) {
    if (length === 0) {
      return new Uint8Array(0);
    }
    while (this.readBuffer.length < length) {
      const chunk = await this.readChunk();
      this.readBuffer = this.readBuffer.length === 0
        ? chunk
        : concatBytes([this.readBuffer, chunk]);
    }
    const out = this.readBuffer.slice(0, length);
    this.readBuffer = this.readBuffer.slice(length);
    return out;
  }

  async readLoop() {
    try {
      while (!this.closed) {
        const packet = await this.readPacket();
        await this.handlePacket(packet.header, packet.payload);
      }
    } catch (error) {
      if (!this.closed) {
        this.connectReject?.(error);
        this.logger(`ADB 连接中断: ${error.message || error}`);
        await this.close();
      }
    }
  }

  async handlePacket(header, payload) {
    switch (header.command) {
      case ADB_COMMANDS.CNXN:
        this.connected = true;
        this.logger(`ADB 已连接: ${utf8Decode(payload).replace(/\0/g, '').trim() || 'unknown'}`);
        this.connectResolve?.();
        this.connectResolve = null;
        this.connectReject = null;
        return;
      case ADB_COMMANDS.AUTH:
        await this.handleAuth(header.arg0, payload);
        return;
      case ADB_COMMANDS.OKAY:
        this.handleOkay(header.arg0, header.arg1);
        return;
      case ADB_COMMANDS.WRTE:
        await this.handleWrite(header.arg0, header.arg1, payload);
        return;
      case ADB_COMMANDS.CLSE:
        await this.handleClose(header.arg0, header.arg1);
        return;
      default:
        this.logger(`ADB 收到未处理数据包: ${header.commandName}`);
    }
  }

  async handleAuth(authType, payload) {
    await this.ensureKeyMaterial();
    if (authType !== ADB_AUTH_TYPES.TOKEN) {
      throw new Error(`不支持的 ADB 认证类型: ${authType}`);
    }

    if (!this.authTriedSignature) {
      this.authTriedSignature = true;
      const signature = new Uint8Array(
        await this.crypto.subtle.sign(
          { name: 'RSASSA-PKCS1-v1_5' },
          this.keyPair.privateKey,
          payload,
        ),
      );
      await this.sendPacket(ADB_COMMANDS.AUTH, ADB_AUTH_TYPES.SIGNATURE, 0, signature);
      if (!this.authSentPublicKey) {
        this.logger('ADB 若设备拒绝签名，将自动请求设备授权');
      }
      return;
    }

    if (!this.authSentPublicKey) {
      this.authSentPublicKey = true;
      this.logger('ADB 发送公钥，请在设备上确认调试授权');
      await this.sendPacket(ADB_COMMANDS.AUTH, ADB_AUTH_TYPES.RSAPUBLICKEY, 0, this.publicKeyPayload);
      return;
    }

    throw new Error('ADB 认证失败，设备未接受签名或公钥');
  }

  handleOkay(remoteId, localId) {
    const stream = this.streams.get(localId);
    if (!stream) {
      return;
    }
    stream.remoteId = remoteId;
    stream.opened = true;
  }

  async handleWrite(remoteId, localId, payload) {
    const stream = this.streams.get(localId);
    if (!stream) {
      await this.sendPacket(ADB_COMMANDS.CLSE, 0, remoteId);
      return;
    }
    stream.chunks.push(payload);
    await this.sendPacket(ADB_COMMANDS.OKAY, localId, remoteId);
  }

  async handleClose(remoteId, localId) {
    const stream = this.streams.get(localId);
    if (!stream) {
      return;
    }
    this.streams.delete(localId);
    await this.sendPacket(ADB_COMMANDS.CLSE, localId, remoteId);
    stream.resolve(utf8Decode(concatBytes(stream.chunks)));
  }

  async runShell(command) {
    if (!this.connected) {
      throw new Error('ADB 尚未连接');
    }
    const localId = this.streamId++;
    const service = utf8Encode(`shell:${command}\0`);
    const resultPromise = new Promise((resolve, reject) => {
      this.streams.set(localId, {
        localId,
        remoteId: 0,
        opened: false,
        chunks: [],
        resolve,
        reject,
      });
    });
    await this.sendPacket(ADB_COMMANDS.OPEN, localId, 0, service);
    return resultPromise;
  }
}
