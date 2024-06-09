const P = require('parsimmon');

const mapPairListToKeyValPairNew = (pairList = []) => {
  // transforms  [ [ 'name', 'parsings' ], [ 'type', 'http' ], [ 'seq', '1' ] ]
  // to { name: 'parsings', type: 'http', seq: '1' }
  return pairList.reduce((acc, [key, value]) => {
    acc[key] = value;
    return acc;
  }, {});
};

const mapPairListToNameValueRecord = (pairList = [], parseEnabled = true) => {
  // converts [['Authorization', 'Bearer 1.2.3']] to [{name: 'Authorization', value: 'Bearer 1.2.3', enabled: true}]
  return pairList.map(([name, value]) => {
    if (!parseEnabled) {
      return {
        name,
        value
      };
    }

    let enabled = true;
    if (name && name.length && name.charAt(0) === '~') {
      name = name.slice(1);
      enabled = false;
    }

    return {
      name,
      value,
      enabled
    };
  });
};

// Utility function to skip optional whitespaces and newlines
function token(p) {
  return p.skip(P.optWhitespace);
}

// Parser for multi-line text blocks
const multiLineTextBlock = P.seq(P.string("'''"), P.regex(/[^]*?(?=''')/), P.string("'''"))
  .desc('multi-line text block')
  .map(([_, content, __]) => content.trim());

// Parser for key-value pairs
const key = P.regex(/[^:\n\r]+/)
  .map((x) => x.trim())
  .desc('key');
const value = P.alt(
  multiLineTextBlock,
  P.regex(/[^\n\r]*/).map((x) => (x.trim().length ? x.trim() : ''))
).desc('value');

// a pair is a key-value pair separated by a colon. Note that the value can be empty, in which case we just return an empty string
const pair = P.seq(token(key), token(P.string(':')), token(value))
  .map(([k, _, v]) => ({ [k]: v }))
  .desc('pair');

const pairList = P.sepBy(pair, P.optWhitespace).desc('pairList');

const dictionary = token(P.string('{'))
  .then(pairList)
  .skip(token(P.string('}')))
  .map((pairs) => Object.assign({}, ...pairs))
  .desc('dictionary');

// Parsers for different HTTP methods
const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'connect', 'trace'].reduce(
  (parsers, method) => {
    parsers[method] = token(P.string(method))
      .then(dictionary)
      .map((dict) => ({ http: { method, ...mapPairListToKeyValPairNew(Object.entries(dict)) } }))
      .desc('http method: ' + method);
    return parsers;
  },
  {}
);

const headers = token(P.string('headers'))
  .then(dictionary)
  .map((dict) => ({ headers: mapPairListToNameValueRecord(Object.entries(dict)) }))
  .desc('headers');

const query = token(P.string('query'))
  .then(dictionary)
  .map((dict) => ({ query: mapPairListToNameValueRecord(Object.entries(dict)) }))
  .desc('query');

const processMeta = (dict) => {
  let metaVal = mapPairListToKeyValPairNew(Object.entries(dict));
  if (!metaVal.seq) {
    metaVal.seq = 1;
  }
  if (!metaVal.type) {
    metaVal.type = 'http';
  }
  return metaVal;
};

const meta = token(P.string('meta'))
  .then(dictionary)
  .map((dict) => ({ meta: processMeta(dict) }))
  .desc('meta');

const jsonArray = P.lazy(() =>
  P.seq(token(P.string('[')), P.sepBy(token(jsonContent), token(P.string(','))), token(P.string(']')))
)
  .map(([_, content, __]) => `[${content.join(',')}]`)
  .desc('json array');

const jsonDict = P.lazy(() =>
  P.seq(
    token(P.string('{')),
    P.sepBy(P.seq(token(key), token(P.string(':')), token(jsonContent)), token(P.string(','))),
    token(P.string('}'))
  )
    .map(([_, content, __]) => {
      return `{${content.map(([k, _, v]) => `${k}:${v}`).join(',')}}`;
    })
    .desc('json dictionary')
);

const jsonBoolean = P.alt(token(P.string('true')), token(P.string('false'))).desc('json boolean');
const jsonNumber = P.regex(/-?\d+(\.\d+)?([eE][+-]?\d+)?/)
  .map(Number)
  .desc('json number');
const jsonString = token(P.regexp(/"((?:\\.|.)*?)"/, 1))
  .map((s) => `"${s}"`)
  .desc('json string');
const jsonNull = token(P.string('null')).desc('json null');

const jsonContent = P.alt(jsonBoolean, jsonNumber, jsonString, jsonArray, jsonDict, jsonNull).desc('json content');

const bodyJson = P.seq(
  token(P.string('body:json')),
  token(P.string('{')),
  token(jsonContent),
  token(P.string('}'))
).map(([_, __, content, ___]) => ({ body: { json: content } }));

const bodies = ['text', 'xml', 'sparql', 'graphql', 'graphql:vars'].reduce((parsers, type) => {
  parsers[`body:${type}`] = token(P.string(`body:${type}`))
    .then(token(P.string('{')))
    .then(multiLineTextBlock)
    .skip(token(P.string('}')))
    .map((content) => ({ body: { [type]: content } }))
    .desc(`body:${type}`);
  return parsers;
}, {});

const bodyFormUrlEncoded = token(P.string('body:form-urlencoded'))
  .then(dictionary)
  .map((dict) => ({ body: { formUrlEncoded: dict } }));

const bodyMultipart = token(P.string('body:multipart-form'))
  .then(dictionary)
  .map((dict) => ({ body: { multipartForm: dict } }))
  .desc('body:multipart-form');

const body = token(P.string('body'))
  .then(token(P.string('{')))
  .then(multiLineTextBlock)
  .skip(token(P.string('}')))
  .map((content) => ({ body: { text: content } }))
  .desc('body');

const script = ['script:pre-request', 'script:post-response'].reduce((parsers, type) => {
  parsers[type] = token(P.string(type))
    .then(token(P.string('{')))
    .then(P.regex(/[^]*?(?=})/))
    .skip(token(P.string('}')))
    .map((content) => ({ script: { [type.split(':')[1]]: content } }));
  return parsers;
}, {});

const tests = token(P.string('tests'))
  .then(token(P.string('{')))
  .then(multiLineTextBlock)
  .skip(token(P.string('}')))
  .map((content) => ({ tests: content }));

const docs = token(P.string('docs'))
  .then(token(P.string('{')))
  .then(multiLineTextBlock)
  .skip(token(P.string('}')))
  .map((content) => ({ docs: content }));

const auths = ['auth:awsv4', 'auth:basic', 'auth:bearer', 'auth:digest', 'auth:oauth2'].reduce((parsers, type) => {
  parsers[type] = token(P.string(type))
    .then(token(dictionary))
    .map((dict) => ({ auth: { [type.split(':')[1]]: dict } }));
  return parsers;
}, {});

const varsAndAssert = ['vars:pre-request', 'vars:post-response', 'assert'].reduce((parsers, type) => {
  parsers[type] = token(P.string(type))
    .then(token(dictionary))
    .map((dict) => ({ [type.split(':')[0]]: dict }));
  return parsers;
}, {});

const grammar = P.alt(
  meta,
  ...Object.values(httpMethods),
  headers,
  query,
  bodyJson,
  ...Object.values(bodies),
  bodyFormUrlEncoded,
  bodyMultipart,
  body,
  ...Object.values(script),
  tests,
  docs,
  ...Object.values(auths),
  ...Object.values(varsAndAssert)
)
  .many()
  .map((results) => Object.assign({}, ...results));

module.exports = grammar;
