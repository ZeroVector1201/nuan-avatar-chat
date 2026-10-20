import test from 'node:test';
import assert from 'node:assert/strict';
import {wav} from '../web/microphone.js';
import {captureConstraints,openMicrophone} from '../web/mic-input.js';

test('recording encoder produces real mono PCM16 WAV, not browser-dependent WebM',()=>{
  const bytes=Buffer.from(wav([Float32Array.from({length:1600},(_,i)=>i%2?.5:-.5)],16000),'base64');
  assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WAVE');
  assert.equal(bytes.readUInt32LE(24),16000);assert.equal(bytes.readUInt16LE(22),1);
  assert.equal(bytes.readUInt32LE(40),3200);assert.equal(bytes.readInt16LE(44),-16383);
});
test('empty, oversize and unsupported recordings are rejected before upload',()=>{
  assert.throws(()=>wav([],16000));assert.throws(()=>wav([new Float32Array(16000*31)],16000));
  assert.throws(()=>wav([new Float32Array(1000)],1000));
});
test('system default input is preferred; missing virtual alias may use browser default',async()=>{
  const calls=[];const stream={};
  const media={getUserMedia:async c=>{calls.push(c);if(calls.length===1)throw Object.assign(Error(),{name:'NotFoundError'});return stream;}};
  assert.equal(await openMicrophone(media),stream);assert.equal(calls[0].audio.deviceId.exact,'default');
  assert.equal(calls[1].audio.deviceId,undefined);
  assert.equal(captureConstraints('default').audio.autoGainControl,false);
});
test('an explicit microphone choice is never silently changed',async()=>{
  const media={getUserMedia:async()=>{throw Object.assign(Error(),{name:'NotFoundError'});}};
  await assert.rejects(openMicrophone(media,'chosen-device'));
});
