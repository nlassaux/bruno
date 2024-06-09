const ohm = require('ohm-js');
const _ = require('lodash');
const util = require('util');
const { outdentString } = require('../../v1/src/utils');
const P = require('parsimmon');

const mapPairListToKeyValPair = (pairList = []) => {
  if (!pairList || !pairList.length) {
    return {};
  }

  return _.merge({}, ...pairList[0]);
};

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

const mapPairListToKeyValPairs = (pairList = [], parseEnabled = true) => {
  if (!pairList.length) {
    return [];
  }
  return _.map(pairList[0], (pair) => {
    let name = _.keys(pair)[0];
    let value = pair[name];

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

const mapPairListToKeyValPairsMultipart = (pairList = [], parseEnabled = true) => {
  const pairs = mapPairListToKeyValPairs(pairList, parseEnabled);

  return pairs.map((pair) => {
    pair.type = 'text';
    if (pair.value.startsWith('@file(') && pair.value.endsWith(')')) {
      let filestr = pair.value.replace(/^@file\(/, '').replace(/\)$/, '');
      pair.type = 'file';
      pair.value = filestr.split('|');
    }
    return pair;
  });
};

// Utility function to skip optional whitespace
function token(p) {
  return p.skip(P.optWhitespace);
}

// Parser for multi-line text blocks
const multiLineTextBlock = P.seq(P.string("'''"), P.regex(/[^]*?(?=''')/), P.string("'''")).map(
  ([start, content, end]) => content.trim()
);

// Parser for key-value pairs
const key = P.regex(/[^:\n\r]+/).map((x) => x.trim());
const value = P.alt(
  multiLineTextBlock,
  P.regex(/[^\n\r]*/).map((x) => x.trim())
);

const pair = P.seq(token(key), token(P.string(':')), token(value)).map(([k, _, v]) => ({ [k]: v }));

const pairList = P.sepBy(pair, P.optWhitespace);

const dictionary = token(P.string('{'))
  .then(pairList)
  .skip(token(P.string('}')))
  .map((pairs) => Object.assign({}, ...pairs));

// Parsers for different HTTP methods
const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'connect', 'trace'].reduce(
  (parsers, method) => {
    parsers[method] = token(P.string(method))
      .then(dictionary)
      .map((dict) => ({ http: { method, ...mapPairListToKeyValPairNew(Object.entries(dict)) } }));
    return parsers;
  },
  {}
);

const headers = token(P.string('headers'))
  .then(dictionary)
  .map((dict) => ({ headers: mapPairListToNameValueRecord(Object.entries(dict)) }));

const query = token(P.string('query'))
  .then(dictionary)
  .map((dict) => ({ query: mapPairListToNameValueRecord(Object.entries(dict)) }));

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
  .map((dict) => ({ meta: processMeta(dict) }));

const bodies = ['json', 'text', 'xml', 'sparql', 'graphql', 'graphql:vars'].reduce((parsers, type) => {
  parsers[`body:${type}`] = token(P.string(`body:${type}`))
    .then(token(P.string('{')))
    .then(multiLineTextBlock)
    .skip(token(P.string('}')))
    .map((content) => ({ body: { [type]: content } }));
  return parsers;
}, {});

const bodyFormUrlEncoded = token(P.string('body:form-urlencoded'))
  .then(dictionary)
  .map((dict) => ({ body: { formUrlEncoded: dict } }));

const bodyMultipart = token(P.string('body:multipart-form'))
  .then(dictionary)
  .map((dict) => ({ body: { multipartForm: dict } }));

const body = token(P.string('body'))
  .then(token(P.string('{')))
  .then(multiLineTextBlock)
  .skip(token(P.string('}')))
  .map((content) => ({ body: { text: content } }));

const script = ['script:pre-request', 'script:post-response'].reduce((parsers, type) => {
  parsers[type] = token(P.string(type))
    .then(token(P.string('{')))
    .then(multiLineTextBlock)
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
    .then(dictionary)
    .map((dict) => ({ auth: { [type.split(':')[1]]: dict } }));
  return parsers;
}, {});

const varsAndAssert = ['vars:pre-request', 'vars:post-response', 'assert'].reduce((parsers, type) => {
  parsers[type] = token(P.string(type))
    .then(dictionary)
    .map((dict) => ({ [type.split(':')[0]]: dict }));
  return parsers;
}, {});

const grammarNew = P.alt(
  meta,
  ...Object.values(httpMethods),
  headers,
  query,
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

/**
 * A Bru file is made up of blocks.
 * There are two types of blocks
 *
 * 1. Dictionary Blocks - These are blocks that have key value pairs
 * ex:
 *  headers {
 *   content-type: application/json
 *  }
 *
 * 2. Text Blocks - These are blocks that have text
 * ex:
 * body:json {
 *  {
 *   "username": "John Nash",
 *   "password": "governingdynamics
 *  }
 *
 */
const grammar = ohm.grammar(`Bru {
  BruFile = (meta | http | query | headers | auths | bodies | varsandassert | script | tests | docs)*
  auths = authawsv4 | authbasic | authbearer | authdigest | authOAuth2
  bodies = bodyjson | bodytext | bodyxml | bodysparql | bodygraphql | bodygraphqlvars | bodyforms | body
  bodyforms = bodyformurlencoded | bodymultipart

  nl = "\\r"? "\\n"
  st = " " | "\\t"
  stnl = st | nl
  tagend = nl "}"
  optionalnl = ~tagend nl
  keychar = ~(tagend | st | nl | ":") any
  valuechar = ~(nl | tagend) any

   // Multiline text block surrounded by '''
  multilinetextblockdelimiter = "'''"
  multilinetextblock = multilinetextblockdelimiter (~multilinetextblockdelimiter any)* multilinetextblockdelimiter

  // Dictionary Blocks
  dictionary = st* "{" pairlist? tagend
  pairlist = optionalnl* pair (~tagend stnl* pair)* (~tagend space)*
  pair = st* key st* ":" st* value st*
  key = keychar*
  value = multilinetextblock | valuechar*
  
  // Dictionary for Assert Block
  assertdictionary = st* "{" assertpairlist? tagend
  assertpairlist = optionalnl* assertpair (~tagend stnl* assertpair)* (~tagend space)*
  assertpair = st* assertkey st* ":" st* value st*
  assertkey = ~tagend assertkeychar*
  assertkeychar = ~(tagend | nl | ":") any

  // Text Blocks
  textblock = textline (~tagend nl textline)*
  textline = textchar*
  textchar = ~nl any

  meta = "meta" dictionary

  http = get | post | put | delete | patch | options | head | connect | trace
  get = "get" dictionary
  post = "post" dictionary
  put = "put" dictionary
  delete = "delete" dictionary
  patch = "patch" dictionary
  options = "options" dictionary
  head = "head" dictionary
  connect = "connect" dictionary
  trace = "trace" dictionary

  headers = "headers" dictionary

  query = "query" dictionary

  varsandassert = varsreq | varsres | assert
  varsreq = "vars:pre-request" dictionary
  varsres = "vars:post-response" dictionary
  assert = "assert" assertdictionary

  authawsv4 = "auth:awsv4" dictionary
  authbasic = "auth:basic" dictionary
  authbearer = "auth:bearer" dictionary
  authdigest = "auth:digest" dictionary
  authOAuth2 = "auth:oauth2" dictionary

  body = "body" st* "{" nl* textblock tagend
  bodyjson = "body:json" st* "{" nl* textblock tagend
  bodytext = "body:text" st* "{" nl* textblock tagend
  bodyxml = "body:xml" st* "{" nl* textblock tagend
  bodysparql = "body:sparql" st* "{" nl* textblock tagend
  bodygraphql = "body:graphql" st* "{" nl* textblock tagend
  bodygraphqlvars = "body:graphql:vars" st* "{" nl* textblock tagend

  bodyformurlencoded = "body:form-urlencoded" dictionary
  bodymultipart = "body:multipart-form" dictionary

  script = scriptreq | scriptres
  scriptreq = "script:pre-request" st* "{" nl* textblock tagend
  scriptres = "script:post-response" st* "{" nl* textblock tagend
  tests = "tests" st* "{" nl* textblock tagend
  docs = "docs" st* "{" nl* textblock tagend
}`);

const concatArrays = (objValue, srcValue) => {
  if (_.isArray(objValue) && _.isArray(srcValue)) {
    return objValue.concat(srcValue);
  }
};

const sem = grammar.createSemantics().addAttribute('ast', {
  BruFile(tags) {
    if (!tags || !tags.ast || !tags.ast.length) {
      return {};
    }

    return _.reduce(
      tags.ast,
      (result, item) => {
        return _.mergeWith(result, item, concatArrays);
      },
      {}
    );
  },
  dictionary(_1, _2, pairlist, _3) {
    return pairlist.ast;
  },
  pairlist(_1, pair, _2, rest, _3) {
    return [pair.ast, ...rest.ast];
  },
  pair(_1, key, _2, _3, _4, value, _5) {
    let res = {};
    res[key.ast] = value.ast ? value.ast.trim() : '';
    return res;
  },
  key(chars) {
    return chars.sourceString ? chars.sourceString.trim() : '';
  },
  value(chars) {
    try {
      let isMultiline = chars.sourceString?.startsWith(`'''`) && chars.sourceString?.endsWith(`'''`);
      if (isMultiline) {
        const multilineString = chars.sourceString?.replace(/^'''|'''$/g, '');
        return multilineString
          .split('\n')
          .map((line) => line.slice(4))
          .join('\n');
      }
      return chars.sourceString ? chars.sourceString.trim() : '';
    } catch (err) {
      console.error(err);
    }
    return chars.sourceString ? chars.sourceString.trim() : '';
  },
  assertdictionary(_1, _2, pairlist, _3) {
    return pairlist.ast;
  },
  assertpairlist(_1, pair, _2, rest, _3) {
    return [pair.ast, ...rest.ast];
  },
  assertpair(_1, key, _2, _3, _4, value, _5) {
    let res = {};
    res[key.ast] = value.ast ? value.ast.trim() : '';
    return res;
  },
  assertkey(chars) {
    return chars.sourceString ? chars.sourceString.trim() : '';
  },
  textblock(line, _1, rest) {
    return [line.ast, ...rest.ast].join('\n');
  },
  textline(chars) {
    return chars.sourceString;
  },
  textchar(char) {
    return char.sourceString;
  },
  nl(_1, _2) {
    return '';
  },
  st(_) {
    return '';
  },
  tagend(_1, _2) {
    return '';
  },
  _iter(...elements) {
    return elements.map((e) => e.ast);
  },
  meta(_1, dictionary) {
    let meta = mapPairListToKeyValPair(dictionary.ast);

    if (!meta.seq) {
      meta.seq = 1;
    }

    if (!meta.type) {
      meta.type = 'http';
    }

    return {
      meta
    };
  },
  get(_1, dictionary) {
    return {
      http: {
        method: 'get',
        ...mapPairListToKeyValPair(dictionary.ast)
      }
    };
  },
  post(_1, dictionary) {
    return {
      http: {
        method: 'post',
        ...mapPairListToKeyValPair(dictionary.ast)
      }
    };
  },
  put(_1, dictionary) {
    return {
      http: {
        method: 'put',
        ...mapPairListToKeyValPair(dictionary.ast)
      }
    };
  },
  delete(_1, dictionary) {
    return {
      http: {
        method: 'delete',
        ...mapPairListToKeyValPair(dictionary.ast)
      }
    };
  },
  patch(_1, dictionary) {
    return {
      http: {
        method: 'patch',
        ...mapPairListToKeyValPair(dictionary.ast)
      }
    };
  },
  options(_1, dictionary) {
    return {
      http: {
        method: 'options',
        ...mapPairListToKeyValPair(dictionary.ast)
      }
    };
  },
  head(_1, dictionary) {
    return {
      http: {
        method: 'head',
        ...mapPairListToKeyValPair(dictionary.ast)
      }
    };
  },
  connect(_1, dictionary) {
    return {
      http: {
        method: 'connect',
        ...mapPairListToKeyValPair(dictionary.ast)
      }
    };
  },
  query(_1, dictionary) {
    return {
      query: mapPairListToKeyValPairs(dictionary.ast)
    };
  },
  headers(_1, dictionary) {
    return {
      headers: mapPairListToKeyValPairs(dictionary.ast)
    };
  },
  authawsv4(_1, dictionary) {
    const auth = mapPairListToKeyValPairs(dictionary.ast, false);
    const accessKeyIdKey = _.find(auth, { name: 'accessKeyId' });
    const secretAccessKeyKey = _.find(auth, { name: 'secretAccessKey' });
    const sessionTokenKey = _.find(auth, { name: 'sessionToken' });
    const serviceKey = _.find(auth, { name: 'service' });
    const regionKey = _.find(auth, { name: 'region' });
    const profileNameKey = _.find(auth, { name: 'profileName' });
    const accessKeyId = accessKeyIdKey ? accessKeyIdKey.value : '';
    const secretAccessKey = secretAccessKeyKey ? secretAccessKeyKey.value : '';
    const sessionToken = sessionTokenKey ? sessionTokenKey.value : '';
    const service = serviceKey ? serviceKey.value : '';
    const region = regionKey ? regionKey.value : '';
    const profileName = profileNameKey ? profileNameKey.value : '';
    return {
      auth: {
        awsv4: {
          accessKeyId,
          secretAccessKey,
          sessionToken,
          service,
          region,
          profileName
        }
      }
    };
  },
  authbasic(_1, dictionary) {
    const auth = mapPairListToKeyValPairs(dictionary.ast, false);
    const usernameKey = _.find(auth, { name: 'username' });
    const passwordKey = _.find(auth, { name: 'password' });
    const username = usernameKey ? usernameKey.value : '';
    const password = passwordKey ? passwordKey.value : '';
    return {
      auth: {
        basic: {
          username,
          password
        }
      }
    };
  },
  authbearer(_1, dictionary) {
    const auth = mapPairListToKeyValPairs(dictionary.ast, false);
    const tokenKey = _.find(auth, { name: 'token' });
    const token = tokenKey ? tokenKey.value : '';
    return {
      auth: {
        bearer: {
          token
        }
      }
    };
  },
  authdigest(_1, dictionary) {
    const auth = mapPairListToKeyValPairs(dictionary.ast, false);
    const usernameKey = _.find(auth, { name: 'username' });
    const passwordKey = _.find(auth, { name: 'password' });
    const username = usernameKey ? usernameKey.value : '';
    const password = passwordKey ? passwordKey.value : '';
    return {
      auth: {
        digest: {
          username,
          password
        }
      }
    };
  },
  authOAuth2(_1, dictionary) {
    const auth = mapPairListToKeyValPairs(dictionary.ast, false);
    const grantTypeKey = _.find(auth, { name: 'grant_type' });
    const usernameKey = _.find(auth, { name: 'username' });
    const passwordKey = _.find(auth, { name: 'password' });
    const callbackUrlKey = _.find(auth, { name: 'callback_url' });
    const authorizationUrlKey = _.find(auth, { name: 'authorization_url' });
    const accessTokenUrlKey = _.find(auth, { name: 'access_token_url' });
    const clientIdKey = _.find(auth, { name: 'client_id' });
    const clientSecretKey = _.find(auth, { name: 'client_secret' });
    const scopeKey = _.find(auth, { name: 'scope' });
    const pkceKey = _.find(auth, { name: 'pkce' });
    return {
      auth: {
        oauth2:
          grantTypeKey?.value && grantTypeKey?.value == 'password'
            ? {
                grantType: grantTypeKey ? grantTypeKey.value : '',
                accessTokenUrl: accessTokenUrlKey ? accessTokenUrlKey.value : '',
                username: usernameKey ? usernameKey.value : '',
                password: passwordKey ? passwordKey.value : '',
                clientId: clientIdKey ? clientIdKey.value : '',
                clientSecret: clientSecretKey ? clientSecretKey.value : '',
                scope: scopeKey ? scopeKey.value : ''
              }
            : grantTypeKey?.value && grantTypeKey?.value == 'authorization_code'
            ? {
                grantType: grantTypeKey ? grantTypeKey.value : '',
                callbackUrl: callbackUrlKey ? callbackUrlKey.value : '',
                authorizationUrl: authorizationUrlKey ? authorizationUrlKey.value : '',
                accessTokenUrl: accessTokenUrlKey ? accessTokenUrlKey.value : '',
                clientId: clientIdKey ? clientIdKey.value : '',
                clientSecret: clientSecretKey ? clientSecretKey.value : '',
                scope: scopeKey ? scopeKey.value : '',
                pkce: pkceKey ? JSON.parse(pkceKey?.value || false) : false
              }
            : grantTypeKey?.value && grantTypeKey?.value == 'client_credentials'
            ? {
                grantType: grantTypeKey ? grantTypeKey.value : '',
                accessTokenUrl: accessTokenUrlKey ? accessTokenUrlKey.value : '',
                clientId: clientIdKey ? clientIdKey.value : '',
                clientSecret: clientSecretKey ? clientSecretKey.value : '',
                scope: scopeKey ? scopeKey.value : ''
              }
            : {}
      }
    };
  },
  bodyformurlencoded(_1, dictionary) {
    return {
      body: {
        formUrlEncoded: mapPairListToKeyValPairs(dictionary.ast)
      }
    };
  },
  bodymultipart(_1, dictionary) {
    return {
      body: {
        multipartForm: mapPairListToKeyValPairsMultipart(dictionary.ast)
      }
    };
  },
  body(_1, _2, _3, _4, textblock, _5) {
    return {
      http: {
        body: 'json'
      },
      body: {
        json: outdentString(textblock.sourceString)
      }
    };
  },
  bodyjson(_1, _2, _3, _4, textblock, _5) {
    return {
      body: {
        json: outdentString(textblock.sourceString)
      }
    };
  },
  bodytext(_1, _2, _3, _4, textblock, _5) {
    return {
      body: {
        text: outdentString(textblock.sourceString)
      }
    };
  },
  bodyxml(_1, _2, _3, _4, textblock, _5) {
    return {
      body: {
        xml: outdentString(textblock.sourceString)
      }
    };
  },
  bodysparql(_1, _2, _3, _4, textblock, _5) {
    return {
      body: {
        sparql: outdentString(textblock.sourceString)
      }
    };
  },
  bodygraphql(_1, _2, _3, _4, textblock, _5) {
    return {
      body: {
        graphql: {
          query: outdentString(textblock.sourceString)
        }
      }
    };
  },
  bodygraphqlvars(_1, _2, _3, _4, textblock, _5) {
    return {
      body: {
        graphql: {
          variables: outdentString(textblock.sourceString)
        }
      }
    };
  },
  varsreq(_1, dictionary) {
    const vars = mapPairListToKeyValPairs(dictionary.ast);
    _.each(vars, (v) => {
      let name = v.name;
      if (name && name.length && name.charAt(0) === '@') {
        v.name = name.slice(1);
        v.local = true;
      } else {
        v.local = false;
      }
    });

    return {
      vars: {
        req: vars
      }
    };
  },
  varsres(_1, dictionary) {
    const vars = mapPairListToKeyValPairs(dictionary.ast);
    _.each(vars, (v) => {
      let name = v.name;
      if (name && name.length && name.charAt(0) === '@') {
        v.name = name.slice(1);
        v.local = true;
      } else {
        v.local = false;
      }
    });

    return {
      vars: {
        res: vars
      }
    };
  },
  assert(_1, dictionary) {
    return {
      assertions: mapPairListToKeyValPairs(dictionary.ast)
    };
  },
  scriptreq(_1, _2, _3, _4, textblock, _5) {
    return {
      script: {
        req: outdentString(textblock.sourceString)
      }
    };
  },
  scriptres(_1, _2, _3, _4, textblock, _5) {
    return {
      script: {
        res: outdentString(textblock.sourceString)
      }
    };
  },
  tests(_1, _2, _3, _4, textblock, _5) {
    return {
      tests: outdentString(textblock.sourceString)
    };
  },
  docs(_1, _2, _3, _4, textblock, _5) {
    return {
      docs: outdentString(textblock.sourceString)
    };
  }
});

const parser = (input) => {
  const matchNew = grammarNew.parse(input);
  console.log(util.inspect(matchNew, true, 4, true));

  const match = grammar.match(input);

  if (match.succeeded()) {
    console.log('AST:', sem(match).ast);
    return sem(match).ast;
  } else {
    throw new Error(match.message);
  }
};

module.exports = parser;
