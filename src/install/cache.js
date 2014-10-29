var EventEmitter = require('events').EventEmitter;
var path = require('path');
var fs = require('fs');
var ff = require('ff');
var crypto = require('crypto');

var Rsync = require('rsync'); // cp/rsync -a
var mkdirp = require('mkdirp'); // mkdir -p
var rimraf = require('rimraf'); // rm -rf

var gitClient = require('../util/gitClient');
var Module = require('../apps/Module');
var logger = require('../util/logging').get('cache');

function randomName() {
  return '' + crypto.randomBytes(4).readUInt32LE(0)
    + crypto.randomBytes(4).readUInt32LE(0);
}

var MODULE_CACHE = path.join(__dirname, '..', '..', 'cache');
var DEFAULT_URL = 'https://github.com/gameclosure/';

var ModuleCache = Class(EventEmitter, function () {
  this.init = function () {
    EventEmitter.call(this);

    if (!fs.existsSync(MODULE_CACHE)) {
      fs.mkdirSync(MODULE_CACHE);
    }

    this._isLoaded = false;
    this._entries = {};

    var entries = fs.readdirSync(MODULE_CACHE);
    var f = ff(this, function () {
      entries.forEach(function (entry) {
        var cachePath = path.join(MODULE_CACHE, entry);

        // waitPlain: ignore cache load errors
        this._loadCachePath(cachePath, f.waitPlain());
      }, this);
    }).cb(function () {
      this._isLoaded = true;
      this.emit('loaded');
    });
  };

  this._loadCachePath = function (cachePath, cb) {
    var git = gitClient.get(cachePath, {extraSilent: true});
    var f = ff(this, function () {
      var next = f();
      git.getLatestLocalTag(function (err, tag) {
        if (err) { return next(err); }

        // Got a tag
        if (tag) {
          return next(null, tag);
        }

        // No tags at all, try the current head.
        git('rev-parse', 'HEAD', {silent: true}, function (err, res) {
          if (err) { return next(err); }
          return next(null, res.replace(/\n/, ''));
        });
      });
    }, function (version) {
      // trim newlines
      f(version);
      var pkg = f();
      git('show', version + ':package.json', function (err, res) {
        if (err) {
          logger.error('Error reading module package.json');
          return pkg('devkit requires module to have valid package.json');
        }
        pkg(null, res);
      });
      var url = f();
      Module.getURL(cachePath, function (err, res) {
        if (err) {
          logger.error('Error getting module URL');
          logger.error(err);
          return url(err);
        }
        url(null, res);
      });
    }, function (version, pkg, url) {
      var data = JSON.parse(pkg);
      var name = data.name;
      var entry = {
        url: url,
        version: version,
        name: name
      };

      var targetPath = path.join(MODULE_CACHE, name);
      if (targetPath !== cachePath && !fs.existsSync(targetPath)) {
        fs.renameSync(cachePath, targetPath);
      }

      this._entries[name] = entry;

      f(entry);
    }).cb(cb);
  };

  var PROTOCOL = /^[a-z][a-z0-9+\-\.]*:/;
  var SSH_URL = /.+?\@.+?:.+/;

  /**
   * add module to cache. If version omitted, fetch latest version
   *
   * @param {string} nameOrUrl
   * @param {string} [version]
   * @param {function} cb
   */
  this.add = function (nameOrURL, version, cb) {

    var git;
    var url = nameOrURL;
    if (!PROTOCOL.test(nameOrURL) && !SSH_URL.test(nameOrURL)) {
      // try the default URL + name scheme
      url = DEFAULT_URL + nameOrURL;
    }

    var once = Promise.promisify(this.once, this);

    // assume we have a valid URL now
    var tempName = path.join(MODULE_CACHE, randomName());

    // return once('loaded').then(function () {

    // });

    var f = ff(this, function () {
      var entry = this._get(nameOrURL);
      if (entry) {
        // if we already have the repo cloned, just set the requested version
        // or the latest version
        f(entry);
        Module.setVersion(path.join(MODULE_CACHE, entry.name), version, f());
      }
    }, function (entry, version) {
      if (entry) {
        // return the cache info with the version we just set
        entry.version = version;
        f.succeed(entry);
      }
    }, function () {
      // otherwise, we need to clone the repo and add it to the cache
      git = gitClient.get(MODULE_CACHE);
      var next = f();

      git('clone', url, tempName, {
        silent: false,
        buffer: false,
        stdio: 'inherit'
      }, function (err, res) {
        if (err) {
          logger.error('Failed to clone', url);
          logger.error(err);
          return next(err);
        }

        next(null, res);
      });

    // }, function () {
    //   var next = f();
    //   git = gitClient.get(path.resolve(MODULE_CACHE, tempName));
    //   git('fetch', 'origin', {silent: true}, next);
    // }, function () {
    //   // check out requested version
    //   var next = f();
    //   git('checkout', '-b', version, {
    //     silent: false
    //   }, function (err, res) {
    //     if (err) {
    //       logger.error('requested version not found', url + '#' + version);
    //       return next(err);
    //     }

    //     return next();
    //   });
    // }, function () {
    //   var next = f();
    //   git('reset', '--hard', 'origin/' + version, {
    //     silent: false
    //   }, function (err, res) {
    //     if (err) {
    //       logger.error('could not reset to origin/' + version);
    //       return next(err);
    //     }

    //     return next();
    //   });

    }, function () {
      // reload cache for proper module name (moves module)
      this._loadCachePath(tempName, f());
    }, function (entry) {
      // get and install the requested version (or the latest version, if none
      // is provided). `install: true` to force run the install scripts when
      // first downloading a module.
      Module.setVersion(path.join(MODULE_CACHE, entry.name), version, {
        forceInstall: true
      }, f.wait());

      f(entry);
    }).error(function () {
      // rimraf(tempName, function () {});
    }).cb(cb);
  };

  this.remove = function (name, cb) {
    var modulePath = path.join(MODULE_CACHE, name);
    rimraf(modulePath, cb);
  };

  this.copy = function (cacheEntry, destPath, cb) {
    var srcPath = path.join(MODULE_CACHE, cacheEntry.name);
    logger.log('installing', cacheEntry.name, 'at', destPath);

    mkdirp(destPath, function (err) {
      if (err) { return cb && cb(err); }

      new Rsync()
        .flags('a')
        .source(srcPath)
        .destination(destPath)
        .execute(cb);
    });
  };

  this.link = function (cacheEntry, destPath, cb) {
    var src = path.join(MODULE_CACHE, cacheEntry.name);
    var dest = path.join(destPath, cacheEntry.name);
    createLink(src, dest, cb);
  };

  this.has = function (nameOrURL) {
    return !!this._get(nameOrURL);
  };

  function cleanURL(url) {
    return url.split('#', 1)[0].replace(/(?:\.git)?\/?$/, '');
  }

  this._get = function (nameOrURL) {
    // ignore versions and trailing slashes for matching against URLs
    var testURL = cleanURL(nameOrURL);
    for (var name in this._entries) {
      if (name === nameOrURL || cleanURL(this._entries[name].url) === testURL) {
        return this._entries[name];
      }
    }
  };
});

function createLink(src, dest, cb) {
  var f = ff(function () {
    try {
      var stat = fs.lstatSync(dest);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }

    if (stat) {
      if (stat.isSymbolicLink()) {
        fs.unlink(dest, f());
      } else {
        throw new Error('Please remove existing module before using --link');
      }
    }
  }, function () {
    fs.symlink(src, dest, 'junction', f());
  }).cb(cb);
}

module.exports = new ModuleCache();
