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
for ( const flockId in flocks ){
    console.log('Flock is stored in corestore namespace:', flockId)
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

### `const userData = flockManager.userData`

### `const flocks = flockManager.flocks`
- `flocks` (object) - all flocks with their flockId as key

### `await flockManager.set(key, value)`
- set a key value pair to the flockManager localBee

### `const value = await flockManager.get(key)`
- get a value from the flockManager localBee

### `const flock = await flockManager.initFlock(invite, options, isNew)`
- `invite` (string) - Optional invite key to join an existing flock.
- `options` (object) - Configuration options for the flock.
- `isNew` (boolean) - true by defalut -> anounces user to flock and saves flockId in local db

### `cosnt invite = flock.invite`
- permanent hex invite key for the flock

### `cosnt { members } = flock.info`
- `members` (object) - Every member of a flock {[z32.encode(flock.autobee.local.key)]: `userData`}.

### `const flockId = flock.flockId`
- local id hex string with which the namespace is opened

### `await flock.set(key, value, encryptionKey)`
- set a new key value pair to the autobase that will sync with all flock peers
- `encryptionKey` - pass an encryption Key for restricted data modification (e.g this.keyPair.secretKey)

### `const value = await flock.get(key)`
- get a value from shared database

### `await flock.leave()`
- leave a flock (NOT FUNCTIONAL UNTIL HYPERCORE "purge" UPDATE)

## Advanced

### `const stream = flockManager.getFlockCoreStream(flock)`
- an alias stream of all hypercores within the flocks namespace
- `data` (stream object) - holds alias and discoveryKey of core

### `const flockDiscoveryKey = flockManager.getDiscoveryKey(invite)`
- gets a discoverykey of a flock using an invite
- `invite` (string) - invite hex key

### `const pair = FlockManager.pair(invite)`
- flockManager.initFlock() uses this automatically when passing an invite
- `invite` (string) - invite hex key
- `pair` (object) - A FlockPairer instance
- `pair.finished()` (method) - returns the joined flock

### `await flockManager.saveFlock(flock)`
- saves the flock namespace to local storage for re-open (automatically handled by .initFlock)

## License

MIT License

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

