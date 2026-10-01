// query-string 7 expects a callable CommonJS export. The upstream security fix
// is ESM. Node >=22.13 and Metro both expose its default through this namespace.
module.exports = require('decode-uri-component-patched').default;
