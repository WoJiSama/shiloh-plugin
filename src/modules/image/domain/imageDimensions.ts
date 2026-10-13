export interface ImageDimensions { width: number; height: number }

// Read original PNG/JPEG/WebP canvas without decoding or modifying the image.
function readUncheckedDimensions(buffer: Buffer): ImageDimensions | null {
 if (buffer.length >= 10 && /^GIF8[79]a$/.test(buffer.subarray(0,6).toString())) return {width:buffer.readUInt16LE(6),height:buffer.readUInt16LE(8)}
 if (buffer.length >= 24 && buffer.subarray(1,4).toString()==='PNG') return {width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)}
 if (buffer[0]===255 && buffer[1]===216) {
  let offset=2
  while(offset+4<=buffer.length) {
   if(buffer[offset++]!==255) continue
   let marker=buffer[offset++];while(marker===255) marker=buffer[offset++]
   if (marker === undefined || offset + 2 > buffer.length) break
   if(marker===217 || marker===218) break
   if(marker===1 || (marker>=208 && marker<=215)) continue
   const length=buffer.readUInt16BE(offset)
   if(length<2 || offset+length>buffer.length) break
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length>=7) return {height:buffer.readUInt16BE(offset+3),width:buffer.readUInt16BE(offset+5)}
   offset+=length
  }
 }
 if(buffer.length>=30 && buffer.subarray(8,12).toString()==='WEBP' && buffer.subarray(12,16).toString()==='VP8X') return {width:buffer.readUIntLE(24,3)+1,height:buffer.readUIntLE(27,3)+1}
 if(buffer.length>=30 && buffer.subarray(8,12).toString()==='WEBP' && buffer.subarray(12,16).toString()==='VP8 ' && buffer.subarray(23,26).equals(Buffer.from([157,1,42]))) return {width:buffer.readUInt16LE(26)&16383,height:buffer.readUInt16LE(28)&16383}
 if(buffer.length>=25 && buffer.subarray(8,12).toString()==='WEBP' && buffer.subarray(12,16).toString()==='VP8L' && buffer[20]===47) {
  const bits=buffer.readUInt32LE(21)
  return {width:(bits&16383)+1,height:((bits>>>14)&16383)+1}
 }
 return null
}

/** Reject malformed zero-size canvases before provider ratio validation. */
export function readImageDimensions(buffer: Buffer): ImageDimensions | null {
 const dimensions = readUncheckedDimensions(buffer)
 return dimensions && dimensions.width > 0 && dimensions.height > 0 ? dimensions : null
}
