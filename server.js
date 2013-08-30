"use strict";

var ldap = require('ldapjs');
var MongoClient = require('mongodb').MongoClient;

var server = ldap.createServer();

if (process.argv.length != 5) {
  console.log("Usage: node", process.argv[1], "mongodb://1.2.3.4:27017/dbname",
	      "collection", "dc=foo,dc=com");
  process.exit(1);
}

var MONGO_URL = process.argv[2],
    COLLECTION = process.argv[3],
    BASE_DN = process.argv[4];

function dn_to_username(dn) {
  if (!dn.parent().equals(BASE_DN) || typeof dn.rdns[0].cn == 'undefined') {
    return new ldap.InvalidCredentialsError();
  }
  return dn.rdns[0].cn;
}

function mongo_to_user(user, home_directory) {
  return {
    dn: 'cn=' + user.username + ',' + BASE_DN,
    attributes: {
      cn: user.username,
      uid: user.username,
      uidNumber: user.uid,
      gidNumber: 10000,
      homeDirectory: home_directory,
      loginShell: '/usr/local/bin/login-shell',
      userPassword: '*',
      objectClass: 'posixAccount',
      gecos: user.public_username
    }
  };
}

// This is not at all how LDAP filters work, but it's good enough for us!
function filter_to_query(filter, query) {
  if (typeof query == 'undefined') query = {};
  if (filter.type == 'equal' && filter.attribute == 'uid') {
    query.username = filter.value;
  } else if (filter.type == 'equal' && filter.attribute == 'uidnumber') {
    query.uid = +filter.value;
  } else if (filter.type == 'and') {
    filter.filters.forEach(function(filter) {
      filter_to_query(filter, query);
    });
  }
  return query;
}

MongoClient.connect(MONGO_URL, function(err, db) {
  if (err) throw err;

  server.search(BASE_DN, function(req, res, next) {
    var query = filter_to_query(req.filter);
    if (Object.keys(query).length == 0) {
      try {
        var name = dn_to_username(req.connection.ldap.bindDN);
      } catch (e) {}
      if (typeof name == 'string') {
        console.log(req.logId, "Feeding", name, "user list with only their own record");
        query.username = name;
      } else {
        console.log(req.logId, "Refusing to provide user list");
        console.log(req.logId, "Query I thought was empty:", req.filter.toString());
        return res.end();
      }
    }
    console.log(req.logId, "Faking search for", query);

    db.collection(COLLECTION).find(query).toArray(function(err, users) {
      if (err) throw err;
      users.forEach(function(user) {
        console.log(req.logId, "Sending result", {username: user.username, uid: user.uid});

        var home_directory = "/";
        res.send(mongo_to_user(user, home_directory));
      });
      res.end();
    });
  });

  server.bind(BASE_DN, function(req, res, next) {
    var name = dn_to_username(req.dn);
    if (name instanceof Error) next(name);
    db.collection(COLLECTION).find({username: name}).toArray(function(err, users) {
      if (err) throw err;
      if (users.length > 0) {
        console.log(req.logId, "Faking bind for", name);
        res.end();
        return next();
      }
      return next(new ldap.InvalidCredentialsError());
    });
  });

  server.listen(1389, '0.0.0.0', function() {
    console.log('Faking users at', server.url);
  });
});
