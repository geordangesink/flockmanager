# FlockManager

FlockManager is a module that facilitates decentralized, peer-to-peer collaboration through the management of "flocks." Flocks are small, self-contained networks that allow users to share and synchronize data using Hyperswarm, Hyperbee, and Autobase.

## Installation

You can install FlockManager via npm:

```sh
npm install flockmanager
```

## Features

- **Manage multiple flocks**: Create, join, and manage flocks with unique identifiers.
- **Blind pairing**: Securely join existing flocks using invite keys.
- **Persistent storage**: Uses Corestore, Autobase and Hyperbee for local and shared storage.
- **Decentralized synchronization**: Leverages Hyperswarm for peer-to-peer communication and Autobase for data synchronization.
- **Custom user data**: Update and store user-specific metadata.

## Usage

### Importing the Module

```javascript
import FlockManager from 'flockmanager'
```

### Creating a FlockManager Instance

```javascript
const manager = new FlockManager('./storage');
await manager.ready();
```

### Retriving Flocks

```javascript
const flocks = manager.flocks
for ( const localId in flocks ){
    console.log('Flock is stored in corestore namespace:', localId)
}
```

### Creating a New Flock

```javascript
const flock = await manager.initFlock();
console.log('New flock created with invite:', flock.invite);
```

### Joining an Existing Flock

```javascript
const invite = 'your-invite-code';
const joinedFlock = await manager.initFlock(invite);
```

### Setting User Data

```javascript
await manager.setUserData({ name: 'Alice', age: '32' });
```

### Cleanup

```javascript
Pear.teardown(async () => {
    await manager.cleanup();
});
```

## API Reference

### `const flockManager = new FlockManager(storageDir, options)`
- `storageDir` (string) - Path for storing data (default: `./storage`).
- `options` (object) - Additional configuration options.

### `await flockManager.cleanup()`
- cleans up all allocated resources and closes manager.

### `await flockManager.setUserData(data)`
- sets and updates userdata encrypted across all flocks
- `data` (object)

### `const info = flock.info`
- the most up to date info object
- `{members: {[this.myId]: userData}}` (object) - userData saved as ``flockInfo/members/${this.myId}``

### `const userData = flockManager.userData`

### `const flocks = flockManager.flocks`
- `flocks` (object) - all flocks with their localId as key

### `await flockManager.set(key, value)`
- set a key value pair to the flockManager localBee

### `const value = await flockManager.get(key)`
- get a value from the flockManager localBee

### `const flock = await flockManager.initFlock(invite, options, isNew)`
- `invite` (string) - Optional invite key to join an existing flock.
- `options` (object) - Configuration options for the flock.
- `isNew` (boolean) - true by defalut -> anounces user to flock and saves localId in local db

### `cosnt invite = flock.invite`
- permanent hex invite key for the flock

### `cosnt { members } = flock.info`
- `members` (object) - Every member of a flock {[z32.encode(flock.autobee.local.key)]: `userData`}.

### `const localId = flock.localId`
- local id hex string with which the namespace is opened

### `await flock.set(key, value, encryptionKey)`
- set a new key value pair to the autobase that will sync with all flock peers
- `encryptionKey` - pass an encryption Key for restricted data modification (e.g this.keyPair.secretKey)

### `const value = await flock.get(key)`
- get a value from shared database

### `const nestedValue = await flock.getByPrefix(prefix)`
- get a nested object for saved directories by providing a prefix
- `prefix` (string) - e.g `'flockInfo/'` will make a nested object of  `'flockInfo/'`, `'flockInfo/members'`...
- `nestedValue` (object) - nested object respective to the directories of the prefix

### `await flock.leave()`
- leave a flock (NOT FUNCTIONAL UNTIL HYPERCORE "purge" UPDATE)

## Advanced

### `const stream = flockManager.getFlockCoreStream(flock)`
- an alias stream of all hypercores within the flocks namespace
- `data` (stream object) - holds alias and discoveryKey of core

### `const flockDiscoveryKey = flockManager.getDiscoveryKey(invite)`
- gets a discoverykey of a flock using an invite
- `invite` (string) - invite hex key

### `const pair = FlockManager.pair(invite, basis, opts)`
- flockManager.initFlock() uses this automatically when passing an invite
- `invite` (string) - invite hex key
- `basis` (object) - basis for flock needs to contain corestore `{corestore, swarm, pairing, bootstrap}`
- `opts` (object) - additional data opts that spread to final flock `{custom, info, userData, localId, isNew, replicate}`
- `pair` (object) - A FlockPairer instance
- `pair.finished()` (method) - returns the joined flock

### `const flocksInfo = await flockManager.flocksBee.get('flocksInfo')`
- locally saved data of information on every flock (MAY CHANGE on hyperdb mmigration)
- `flocksInfo` (map) - `[[ Id, Map([['custom', {}]]) ]]`

### `await flockManager.saveFlock(flock)`
- saves the flock namespace Id along its `.custom` to local storage for re-open (automatically handled by .initFlock)

## License

MIT License

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

