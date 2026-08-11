#!/usr/bin/osascript -l JavaScript

ObjC.import('Foundation');

function fail(message) {
  throw new Error(message);
}

function stringValue(value) {
  if (!value) return '';
  return ObjC.unwrap(value);
}

function setValue(dictionary, key, value) {
  dictionary.setObjectForKey(value, $(key));
}

function run(argv) {
  var options = {
    appName: '',
    bundleIdentifier: '',
    canonicalPath: '',
    defaultsDomain: 'com.apple.dock'
  };

  for (var index = 0; index < argv.length; index += 1) {
    var argument = argv[index];
    if (argument === '--app-name') options.appName = argv[++index] || fail('Missing value for --app-name');
    else if (argument === '--bundle-id') options.bundleIdentifier = argv[++index] || fail('Missing value for --bundle-id');
    else if (argument === '--canonical-app') options.canonicalPath = argv[++index] || fail('Missing value for --canonical-app');
    else if (argument === '--defaults-domain') options.defaultsDomain = argv[++index] || fail('Missing value for --defaults-domain');
    else fail('Unknown argument: ' + argument);
  }

  if (!options.appName || !options.bundleIdentifier || !options.canonicalPath) {
    fail('--app-name, --bundle-id, and --canonical-app are required');
  }
  if (options.canonicalPath[0] !== '/' || options.canonicalPath === '/') {
    fail('--canonical-app must be an absolute non-root path');
  }

  var fileManager = $.NSFileManager.defaultManager;
  if (!fileManager.fileExistsAtPath($(options.canonicalPath))) {
    fail('Canonical app does not exist: ' + options.canonicalPath);
  }

  var defaults = $.NSUserDefaults.alloc.initWithSuiteName($(options.defaultsDomain));
  var existing = defaults.arrayForKey($('persistent-apps'));
  var apps = existing ? $.NSMutableArray.arrayWithArray(existing) : $.NSMutableArray.array;

  for (var appIndex = Number(apps.count) - 1; appIndex >= 0; appIndex -= 1) {
    var item = apps.objectAtIndex(appIndex);
    var tileData = item.objectForKey($('tile-data'));
    if (!tileData) continue;
    var bundleID = stringValue(tileData.objectForKey($('bundle-identifier')));
    var label = stringValue(tileData.objectForKey($('file-label')));
    var fileData = tileData.objectForKey($('file-data'));
    var urlString = fileData ? stringValue(fileData.objectForKey($('_CFURLString'))) : '';
    var path = '';
    if (urlString) {
      var url = $.NSURL.URLWithString($(urlString));
      if (url) path = stringValue(url.path);
    }
    var matches = bundleID === options.bundleIdentifier ||
      label.toLowerCase() === options.appName.toLowerCase() ||
      path.split('/').filter(Boolean).pop() === options.appName + '.app';
    if (matches) apps.removeObjectAtIndex(appIndex);
  }

  var canonicalURL = $.NSURL.fileURLWithPathIsDirectory($(options.canonicalPath), true);
  var canonicalFileData = $.NSMutableDictionary.dictionary;
  setValue(canonicalFileData, '_CFURLString', canonicalURL.absoluteString);
  setValue(canonicalFileData, '_CFURLStringType', $(15));

  var canonicalTileData = $.NSMutableDictionary.dictionary;
  setValue(canonicalTileData, 'bundle-identifier', $(options.bundleIdentifier));
  setValue(canonicalTileData, 'file-data', canonicalFileData);
  setValue(canonicalTileData, 'file-label', $(options.appName));
  setValue(canonicalTileData, 'file-type', $(41));

  var canonicalEntry = $.NSMutableDictionary.dictionary;
  setValue(canonicalEntry, 'tile-data', canonicalTileData);
  setValue(canonicalEntry, 'tile-type', $('file-tile'));
  apps.addObject(canonicalEntry);

  defaults.setObjectForKey(apps, $('persistent-apps'));
  if (!defaults.synchronize()) fail('Could not persist Dock launcher configuration');
  return 'Dock launcher consolidated: ' + options.appName + ' -> ' + options.canonicalPath;
}
