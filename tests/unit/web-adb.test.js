import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADB_COMMANDS,
  WebAdbSession,
  buildAdbPublicKeyPayloadFromJwk,
  decodeAdbHeader,
  encodeAdbPacket,
  findAdbInterface,
} from '../../src/browser/web-adb.js';

test('encodeAdbPacket encodes header and payload correctly', () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  const packet = encodeAdbPacket(ADB_COMMANDS.CNXN, 1, 2, payload);
  assert.equal(packet.length, 28);

  const header = decodeAdbHeader(packet.subarray(0, 24));
  assert.equal(header.command, ADB_COMMANDS.CNXN);
  assert.equal(header.arg0, 1);
  assert.equal(header.arg1, 2);
  assert.equal(header.payloadLength, 4);
  assert.equal(header.payloadChecksum, 10);
  assert.equal(header.magic, (ADB_COMMANDS.CNXN ^ 0xffffffff) >>> 0);
  assert.deepEqual(Array.from(packet.subarray(24)), [1, 2, 3, 4]);
});

test('findAdbInterface finds bulk endpoints from ADB alternate', () => {
  const info = findAdbInterface({
    configurations: [{
      configurationValue: 1,
      interfaces: [{
        interfaceNumber: 3,
        alternates: [{
          alternateSetting: 0,
          interfaceClass: 0xff,
          interfaceSubclass: 0x42,
          interfaceProtocol: 0x01,
          endpoints: [
            { direction: 'in', type: 'bulk', endpointNumber: 6, packetSize: 512 },
            { direction: 'out', type: 'bulk', endpointNumber: 5, packetSize: 512 },
          ],
        }],
      }],
    }],
  });

  assert.deepEqual(info, {
    configurationValue: 1,
    interfaceNumber: 3,
    alternateSetting: 0,
    inEndpoint: 6,
    outEndpoint: 5,
    packetSize: 512,
  });
});

test('buildAdbPublicKeyPayloadFromJwk returns adb-formatted base64 payload', async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-1',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const payload = await buildAdbPublicKeyPayloadFromJwk(jwk, 'unit@test');
  const text = new TextDecoder().decode(payload);

  assert.match(text, /^[A-Za-z0-9+/=]+ unit@test\0$/);
  assert.equal(text.endsWith('\0'), true);
});

test('readPacket handles transfer chunks that include extra payload bytes', async () => {
  const payload = new Uint8Array([11, 22, 33, 44]);
  const packet = encodeAdbPacket(ADB_COMMANDS.CNXN, 1, 2, payload);
  const transfers = [
    packet.subarray(0, 28),
  ];
  const device = {
    async transferIn(_endpoint, _length) {
      const chunk = transfers.shift();
      return {
        status: 'ok',
        data: new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      };
    },
  };

  const session = new WebAdbSession({
    device,
    storage: null,
    crypto,
  });
  session.interfaceInfo = {
    inEndpoint: 1,
    outEndpoint: 2,
    packetSize: 512,
  };

  const result = await session.readPacket();
  assert.equal(result.header.command, ADB_COMMANDS.CNXN);
  assert.deepEqual(Array.from(result.payload), [11, 22, 33, 44]);
  assert.equal(session.readBuffer.length, 0);
});

test('readPacket assembles payload across multiple packet-sized USB reads', async () => {
  const payload = Uint8Array.from({ length: 20 }, (_, index) => index + 1);
  const packet = encodeAdbPacket(ADB_COMMANDS.AUTH, 1, 0, payload);
  const transfers = [
    packet.subarray(0, 8),
    packet.subarray(8, 16),
    packet.subarray(16, 24),
    packet.subarray(24, 32),
    packet.subarray(32),
  ];
  const lengths = [];
  const device = {
    async transferIn(_endpoint, length) {
      lengths.push(length);
      const chunk = transfers.shift();
      return {
        status: 'ok',
        data: new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      };
    },
  };

  const session = new WebAdbSession({
    device,
    storage: null,
    crypto,
  });
  session.interfaceInfo = {
    inEndpoint: 1,
    outEndpoint: 2,
    packetSize: 8,
  };

  const result = await session.readPacket();
  assert.equal(result.header.command, ADB_COMMANDS.AUTH);
  assert.deepEqual(Array.from(result.payload), Array.from(payload));
  assert.deepEqual(lengths, [8, 8, 8, 8, 8]);
});

test('readPacket accepts zero checksum packets from non-standard adb implementations', async () => {
  const payload = Uint8Array.from([9, 8, 7, 6]);
  const packet = encodeAdbPacket(ADB_COMMANDS.AUTH, 1, 0, payload);
  const packetWithZeroChecksum = packet.slice();
  const view = new DataView(
    packetWithZeroChecksum.buffer,
    packetWithZeroChecksum.byteOffset,
    packetWithZeroChecksum.byteLength,
  );
  view.setUint32(16, 0, true);

  const device = {
    async transferIn(_endpoint, _length) {
      return {
        status: 'ok',
        data: new DataView(
          packetWithZeroChecksum.buffer,
          packetWithZeroChecksum.byteOffset,
          packetWithZeroChecksum.byteLength,
        ),
      };
    },
  };

  const session = new WebAdbSession({
    device,
    storage: null,
    crypto,
  });
  session.interfaceInfo = {
    inEndpoint: 1,
    outEndpoint: 2,
    packetSize: 512,
  };

  const result = await session.readPacket();
  assert.equal(result.header.payloadChecksum, 0);
  assert.deepEqual(Array.from(result.payload), [9, 8, 7, 6]);
});

test('handleAuth signs first and sends public key on second token', async () => {
  const sent = [];
  const device = {};
  const session = new WebAdbSession({
    device,
    storage: null,
    crypto,
  });
  session.sendPacket = async (command, arg0, arg1, payload) => {
    sent.push({ command, arg0, arg1, payloadLength: payload.length });
  };
  await session.ensureKeyMaterial();

  const token = Uint8Array.from([1, 2, 3, 4]);
  await session.handleAuth(1, token);
  await session.handleAuth(1, token);

  assert.equal(sent[0].command, ADB_COMMANDS.AUTH);
  assert.equal(sent[0].arg0, 2);
  assert.equal(sent[1].command, ADB_COMMANDS.AUTH);
  assert.equal(sent[1].arg0, 3);
});
