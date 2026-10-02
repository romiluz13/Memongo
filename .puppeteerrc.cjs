// The docs toolchain (mintlify → @mintlify/scraping) pulls in puppeteer; its install-time browser download is optional for this repo, so skip it.
module.exports = { skipDownload: true }
