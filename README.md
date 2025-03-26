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
const flocks = manager.flocks // object of flock instances
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
await manager.setUserData({ name: 'Alice', role: 'Organizer' });
```

### Cleanup

```javascript
Pear.teardown(async () => {
    await manager.cleanup();
});
```

### Managing Flocks

#### Delete a Flock
```javascript
await manager.deleteFlock(flock);
```

#### Cleanup All Resources
```javascript
await manager.cleanup();
```

## API Reference

### `new FlockManager(storageDir, options)`
- `storageDir` (string) - Path for storing data (default: `./storage`).
- `options` (object) - Additional configuration options.

### `.initFlock(invite, options, isNew)`
- `invite` (string) - Optional invite key to join an existing flock.
- `options` (object) - Configuration options for the flock.
- `isNew` (boolean) - If true, creates a new flock; otherwise, joins an existing one.

### `.setUserData(userData)`
- `userData` (object) - Custom user metadata.

### `.getFlockOptions(flockId)`
- `flockId` (string) - Unique local identifier of the flock.

### `.deleteFlock(flock)`
- `flock` (object) - The flock instance to delete. !NOT FUNCTIONAL YET

### `.saveFlock(flock)`
- `flock` (object) - The flock instance to save.

### `.cleanup()`
- Cleans up all allocated resources.

## License

MIT License

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

