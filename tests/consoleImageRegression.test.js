import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import sharp from 'sharp'
import {readImageDimensions} from '../utils/imageDimensions.js'
const source=await fs.readFile(new URL('../console/server.js',import.meta.url),'utf8')
function slice(a,b){return source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)))}
test('custom dimensions reject zero',()=>{
 const normalize=new Function(`${slice('function normalizeCustomSize','function normalizeQuality')};return normalizeCustomSize`)()
 assert.throws(()=>normalize('0x0'));assert.equal(normalize('720×1280'),'720x1280')
})
test('image materializer rejects fake images and retains valid original bytes',async()=>{
 const materialize=new Function('readImageDimensions','sniffImageMime',`${slice('async function materializeImageResult','function saveDrawResult')};return materializeImageResult`)(readImageDimensions,()=> 'image/png')
 await assert.rejects(materialize('base64://'+Buffer.from('<html>error</html>').toString('base64')),/无效/)
 const buffer=await sharp({create:{width:72,height:128,channels:3,background:'blue'}}).png().toBuffer()
 assert.deepEqual((await materialize('base64://'+buffer.toString('base64'))).buffer,buffer)
})
test('Grok validation reuses downloaded bytes and cancellation stays scoped',()=>{
 assert.match(source,/result.images\[index\] = `base64:\/\//)
 assert.match(source,/signal.owner === \(session\?\.username/)
 assert.match(source,/materializeImageResult\(rawImages\[index\], cancelSignal.signal\)/)
})
