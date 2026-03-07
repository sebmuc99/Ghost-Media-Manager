'use strict';

const sharp = require('sharp');

/**
 * Converts a portrait image to 16:9 landscape format.
 * Uses a blurred, stretched version of the original as background.
 * Returns a Buffer — no intermediate file is written to disk.
 *
 * @param {Buffer} inputBuffer - Input image as Buffer
 * @param {number} targetWidth - Target width in pixels (default: 1200)
 * @returns {Promise<Buffer>}
 */
async function portraitToLandscape(inputBuffer, targetWidth = 1200) {
    const targetHeight = Math.round(targetWidth / (16 / 9));

    // Background: stretched + heavily blurred
    const bgBuffer = await sharp(inputBuffer)
        .resize(targetWidth, targetHeight, { fit: 'cover' })
        .blur(40)
        .toBuffer();

    // Foreground: original scaled to target height, centered
    const fgBuffer = await sharp(inputBuffer)
        .resize(null, targetHeight, { fit: 'inside' })
        .toBuffer();

    const fgMeta = await sharp(fgBuffer).metadata();
    const left   = Math.round((targetWidth - fgMeta.width) / 2);

    // Compose: overlay original centered on blurred background
    return sharp(bgBuffer)
        .composite([{ input: fgBuffer, left, top: 0 }])
        .jpeg({ quality: 90 })
        .toBuffer();
}

/**
 * Converts a post title into an SEO-friendly filename.
 * Transliterates German umlauts; replaces other special characters with hyphens.
 * Non-Latin characters not explicitly handled are stripped by the regex.
 *
 * @param {string} title - Post title
 * @returns {string} - e.g. "schloss-linderhof-landscape.jpg"
 */
function titleToFilename(title) {
    return title
        .toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 60)
        + '-landscape.jpg';
}

module.exports = { portraitToLandscape, titleToFilename };
