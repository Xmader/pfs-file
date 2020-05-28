// @ts-check


const fs = require("fs")
const path = require("path")
const crc32 = require("buffer-crc32")  // Derived from the sample CRC implementation in the PNG specification


const pfsdata = fs.readFileSync("./root.pfs.000")
const pfsdataView = new DataView(pfsdata.buffer)
const OUTPUT_DIR = "./out"


// 
// get the file list
// 
const getFileList = () => {
    // the pfs file data structure
    // see ./norn9.bms

    let offset = 0
    offset += 3  // "pf8" file header
    offset += 4  // INFO_SIZE long

    const fileCount = pfsdataView.getUint32(offset, true)
    offset += 4

    /** @type {{ name: string; offset: number; size: number; }[]} */
    const files = []
    for (let i = 0; i < fileCount; i++) {
        const namesz = pfsdataView.getUint32(offset, true)
        offset += 4

        const filenameData = pfsdata.slice(offset, offset + namesz)
        const filename = new TextDecoder().decode(filenameData)
        offset += namesz

        offset += 4  // ZERO long

        const fileoffset = pfsdataView.getUint32(offset, true)
        offset += 4

        const filesize = pfsdataView.getUint32(offset, true)
        offset += 4

        files.push({
            name: filename.replace(/\\/g, "/"),  // convert from win32 style file path
            offset: fileoffset,
            size: filesize,
        })
    }
    return files
}
const FILES = getFileList()


/**
 * @param {(typeof FILES)[0]} fileinfo 
 */
const getFileData = (fileinfo) => {
    return pfsdata.slice(fileinfo.offset, fileinfo.offset + fileinfo.size)
}


// 
// guess encryption key
// 
const KEYSZ = 20

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52])
const PNG_CHUNK_TYPES = ["PLTE", "IDAT", "bKGD", "cHRM", "dSIG", "eXIf", "gAMA", "hIST", "iCCP", "iTXt", "pHYs", "sBIT", "sPLT", "sRGB", "sTER", "tEXt", "tIME", "tRNS", "zTXt"]  // IHDR and IEND are impossible here

const guessEncryptionKey = () => {
    const key = new Uint8Array(KEYSZ)


    // pick a png file
    const info = FILES.find(({ name }) => name.endsWith(".png"))
    const data = getFileData(info)


    // the first 16 bytes of an png file is consistent, so get the first 16 bytes of the XOR key
    for (let i = 0; i < PNG_HEADER.length; i++) {
        key[i] = PNG_HEADER[i] ^ data[i]
    }


    // 
    // calculate the remaining 4 bytes using the CRC data of the IHDR (Image Header) chunk, 
    // and the 36th - 39th byte of the png data (the last byte of the second chunk's length data, and the first three bytes of the chunk type data)
    // 
    // possibilities: 256 * (13 total chunk types - 2)
    // 
    // See 5.3 Chunk layout - https://www.w3.org/TR/PNG/#5Chunk-layout
    // 
    // all descriptions of nth byte are 0-based
    // 
    const ihdrEncrypted = data.slice(
        8, // 8 bytes of PNG signature - See 5 Datastream structure - https://www.w3.org/TR/PNG/#5DataRep
        8 + 4 + 4 + 13 + 4  // 4 bytes of length data, 4 bytes of the chunk type, 13 bytes of the IHDR chunk data, 4 bytes of CRC data - See 5.3 Chunk layout and 11.2.2 IHDR Image header - https://www.w3.org/TR/PNG/#11IHDR
    )
    // half decrypted IHDR, except the `Width` in IHDR (16th - 19th byte of the png data)
    const ihdr = ihdrEncrypted.map((d, i) => {
        return d ^ key[(i + 8) % 20]
    })
    const crc = ihdr.slice(-4)

    // guess the actual chunk type of the second chunk
    const tl = String.fromCharCode(data[40] ^ key[0])  // the last byte of the chunk type data of the second chunk
    const possibleChunkTypes = PNG_CHUNK_TYPES.map(t => {
        if (t.endsWith(tl)) {
            return t
        }
    }).filter(Boolean)

    // calculate CRC on the preceding bytes in the chunk, including the chunk type field and chunk data fields
    let toCalc = Buffer.from(ihdr.slice(4, 4 + 4 + 13))

    guessKey:
    for (const t of possibleChunkTypes) {
        // try to set the KEY byte by calculating from a possible chunk type 
        key[17] = t[0].charCodeAt(0) ^ data[37]
        key[18] = t[1].charCodeAt(0) ^ data[38]
        key[19] = t[2].charCodeAt(0) ^ data[39]

        for (let k = 0; k < 256; k++) {
            key[16] = k

            // re-decrypt the `Width` data in IHDR (16th - 19th byte of the png data)
            for (let i = 0; i < 4; i++) {
                toCalc[4 + i] = data[16 + i] ^ key[16 + i]
            }

            // calculate the crc
            if (crc32(toCalc).equals(crc)) {
                break guessKey
            }
        }
    }


    return key
}
const KEY = guessEncryptionKey()
console.log("encryption key:", KEY)


// 
// decrypt and extract files
// 
for (const f of FILES) {
    const filedata = getFileData(f)
    const decrypted = filedata.map((d, i) => {
        return d ^ KEY[i % 20]
    })

    const filepath = path.join(OUTPUT_DIR, f.name)
    fs.mkdirSync(path.dirname(filepath), { recursive: true })
    fs.writeFileSync(filepath, decrypted)
}
