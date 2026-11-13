import test from 'node:test';
import assert from 'node:assert/strict';
import {validateVehiclePhotos, normalizeVehicleRecognition} from '../src/vehicle_recognition.js';

const photo = {mime_type: 'image/jpeg', data: Buffer.from([255,216,255,1]).toString('base64')};
test('only one or two supported photos are accepted', () => {
  assert.equal(validateVehiclePhotos([photo]).length, 1);
  assert.equal(validateVehiclePhotos([photo, photo]).length, 2);
  for (const images of [[], null, [photo, photo, photo], [{...photo, mime_type:'text/plain'}],
    [{...photo, data: Buffer.from('not a photo').toString('base64')}]]) {
    assert.throws(() => validateVehiclePhotos(images), {statusCode:422});
  }
});
test('identification keeps uncertainty and limits additional photo requests', () => {
  const input = {candidates:[{category:'motorcycle',make:'Honda',model:'CB350',year:2020,
    fuel_type:'petrol',confidence:5}],needs_another_photo:true};
  const result = normalizeVehicleRecognition(input, 2);
  assert.equal(result.candidates[0].year, null);
  assert.equal(result.candidates[0].fuel_type, null);
  assert.equal(result.candidates[0].confidence, 1);
  assert.equal(result.needs_another_photo, false);
  assert.equal(normalizeVehicleRecognition({candidates:[]}, 1).needs_another_photo, true);
});
test('malformed upstream identification is a retryable provider error', () => {
  assert.throws(() => normalizeVehicleRecognition('invalid JSON', 1), {statusCode:502});
  assert.throws(() => normalizeVehicleRecognition('{}', 1), {statusCode:502});
});
