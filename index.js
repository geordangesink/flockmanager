const BlindPairing = require('blind-pairing')
const Corestore = require('corestore')
const Autobase = require('autobase')
const Hyperswarm = require('hyperswarm')
const Hyperbee = require('hyperbee')
const RAM = require('random-access-memory')
const ReadyResource = require('ready-resource')
const { EventEmitter } = require('events')
const z32 = require('z32')
const b4a = require('b4a')
const c = require('compact-encoding')

/**
 * @typedef {class} [FlockManager] - Creates, saves and manages all flocks
 * @param {string} [storageDir] - difine a storage path (defaults to ./storage)
 * @property {Corestore} [corestore] - Corestore instance
 * @property {Hyperbee} [localBee] - local hyperbee for personal storage (for now)
 * @property {Hyperswarm} [swarm] - Hyperswarm instance
 * @property {BlindPairing} [pairing] - BlindPairing instance
 * @property {Object} [flocks] - flockId key and flock instance value
 * @property {Set} [discoveryKeys] - joined flocks dicovery keys
 */
class FlockManager extends ReadyResource {
  constructor (storageDir, opts = {}) {
    super()
    this.storageDir = storageDir || './storage'
    this.corestore = new Corestore(this.storageDir)
    this.localBee = null
    this.bootstrap = opts.bootstrap || null
    this.swarm = new Hyperswarm({ bootstrap: this.bootstrap })
    this.pairing = new BlindPairing(this.swarm)
    this.flocks = {}
    this.userData = {}
    this.discoveryKeys = new Set()
    this.ready().catch(noop)
  }

  async _open () {
    await this.corestore.ready()
    this.localBee = new Hyperbee(
      this.corestore.namespace('localData').get({ name: 'localBee' }),
      {
        keyEncoding: 'utf-8',
        valueEncoding: c.any
      }
    )
    await this.localBee.ready()
    const flocksInfo = await this.localBee.get('flocksInfo')
    const userDataDb = await this.localBee.get('userData')
    if (flocksInfo && flocksInfo.value) {
      const flocksInfoMap = jsonToMap(flocksInfo.value.toString())
      const userData = userDataDb && userDataDb.value
      this.userData = userData
      for (const [flockId, infoMap] of flocksInfoMap) {
        const info = infoMap.get('info')
        await this.initFlock(undefined, { info, flockId, userData }, false)
      }
    } else {
      await this.localBee.put('flocksInfo', mapToJson(new Map()))
    }
  }

  /**
   * pass an object with props to update userData
   * @param {object} userData - update userData
   */
  async setUserData (userData) {
    this.userData = userData
    const userDataDb = await this.localBee.get('userData')
    if (userDataDb && userDataDb.value) {
      const oldUserData = userDataDb.value
      const newUserData = { ...oldUserData, ...userData }
      await this.localBee.put('userData', newUserData)
    }
  }

  /**
   * Gets configuration options for a new flock
   * @param {string} flockId - Unique flock identifier
   * @returns {Object} flock configuration options
   */
  getFlockOptions (flockId) {
    const corestore = flockId ? this.corestore.namespace(flockId) : this.corestore
    return { corestore, swarm: this.swarm, pairing: this.pairing }
  }

  /**
   * initializes a flock (bypasses joinability check)
   * (or creates if no flockId provided)
   * @param {string} [invite] - Optional input invite
   * @param {Object} [opts={}] - flock configuration options
   * @param {boolean} [isNew] - defaults to true
   * @returns {flock} New flock instance
   */
  async initFlock (invite = '', opts = {}, isNew = true) {
    let flock
    const flockId = opts.flockId || generateFlockId()
    const baseOpts = { ...opts, flockId, ...this.getFlockOptions(flockId), userData: this.userData, isNew }
    if (invite) {
      // check for invalid invite or already joined
      const discoveryKey = await this.getDiscoveryKey(invite)
      if (discoveryKey === 'invalid') return false
      else if (discoveryKey) return this._findFlock(discoveryKey)

      const pair = FlockManager.pair(invite, baseOpts)
      flock = await pair.finished()
      flock.on('leaveflock', () => this.deleteFlock(flock))
      // save flock if its new
      if (isNew) flock.on('allDataThere', () => this.saveFlock(flock))
    } else {
      // save flock if its new
      flock = new Flock(baseOpts)
      flock.on('leaveflock', () => this.deleteFlock(flock))
      if (isNew) flock.on('allDataThere', () => this.saveFlock(flock))
      await flock.ready()
    }

    this.flocks[flockId] = flock
    flock.on('flockClosed', () => {
      delete this.flocks[flockId]
      if (this.closingDown) return
      if (Object.keys(this.flocks).length > 0) return
      queueMicrotask(() => this.emit('lastFlockClosed'))
    })
    queueMicrotask(() => this.emit('newFlock', flock))

    if (!this.discoveryKeys.has(flock.discoveryKey)) { this.discoveryKeys.add(flock.discoveryKey) }

    return flock
  }

  /**
   * when joining an existing flock
   * @param {Object} opts
   */
  static pair (invite, opts = {}) {
    const store = opts.corestore
    return new FlockPairer(store, invite, opts)
  }

  async updateFlockInfo (flock) {
    try {
      const flocksInfoDb = await this.localBee.get('flocksInfo')
      const flocksInfoMap = jsonToMap(flocksInfoDb.value.toString())
      flocksInfoMap.get(flock.flockId).set('info', flock.info)
      await this.localBee.put('flocksInfo', Buffer.from(mapToJson(flocksInfoMap)))
    } catch (err) {
      console.error('error updating flock. does the flock exist?', err)
    }
  }

  async getDiscoveryKey (invite) {
    try {
      const discoveryKey = await BlindPairing.decodeInvite(z32.decode(invite))
        .discoveryKey
      return (
        this.discoveryKeys.has(z32.encode(discoveryKey)) &&
        z32.encode(discoveryKey)
      )
    } catch (err) {
      console.error(`invalid invite key: ${invite}`)
      return 'invalid'
    }
  }

  async deleteFlock (flock) {
    // TODO: purge storage of corestore namespace

    const flocksInfoDb = await this.localBee.get('flocksInfo')
    const flocksInfoMap = flocksInfoDb
      ? jsonToMap(flocksInfoDb.value.toString())
      : new Map()

    if (flocksInfoMap.has(flock.flockId)) {
      flocksInfoMap.delete(flock.flockId)
      await this.localBee.put('flocksInfo', Buffer.from(mapToJson(flocksInfoMap)))
    }
  }

  /**
   *  store folder key and flock id in personal db
   */
  async saveFlock (flock) {
    const flocksInfoDb = await this.localBee.get('flocksInfo')
    const flocksInfoMap = flocksInfoDb
      ? jsonToMap(flocksInfoDb.value.toString())
      : new Map()
    if (!flocksInfoMap.has(flock.flockId)) {
      const detailsMap = new Map([['info', flock.info]])
      flocksInfoMap.set(flock.flockId, detailsMap)
      await this.localBee.put('flocksInfo', Buffer.from(mapToJson(flocksInfoMap)))
    }
  }

  async _findFlock (discoveryKey) {
    for (const flockId in this.flocks) {
      if (
        z32.encode(this.flocks[flockId].metadata.discoveryKey) === discoveryKey
      ) {
        return this.flocks[flockId]
      }
    }
  }

  async cleanup () {
    const exitPromises = Object.values(this.flocks).map((flock) => flock.exit())
    await Promise.all(exitPromises)
    this.flocks = {}

    // Clean up other resources
    await this.pairing.close()
    await this.swarm.destroy()
    await this.corestore.close()
  }

  isClosingDown () {
    return this.closingDown
  }
}

/**
 * @typedef {class} [FlockPairer] - pairs to an existing flock using invite key
 */
class FlockPairer extends ReadyResource {
  constructor (store, invite, opts = {}) {
    super()
    this.info = opts.info
    this.userData = opts.userData
    this.flockId = opts.flockId
    this.store = store
    this.invite = invite
    this.swarm = opts.swarm
    this.pairing = opts.pairing
    this.candidate = null
    this.bootstrap = opts.bootstrap || null
    this.onresolve = null
    this.onreject = null
    this.flock = null

    this.ready()
  }

  async _open () {
    const store = this.store
    this.swarm.on('connection', (connection, peerInfo) => {
      store.replicate(connection)
    })
    if (!this.pairing) this.pairing = new BlindPairing(this.swarm)
    const core = Autobee.getLocalCore(this.store)
    await core.ready()
    const key = core.key
    await core.close()
    this.candidate = this.pairing.addCandidate({
      invite: z32.decode(this.invite),
      userData: key,
      onadd: async (result) => {
        if (this.flock === null) {
          this.flock = new Flock({
            corestore: this.store,
            swarm: this.swarm,
            pairing: this.pairing,
            key: result.key,
            encryptionKey: result.encryptionKey,
            bootstrap: this.bootstrap,
            isNew: true,
            info: this.info,
            userData: this.userData,
            flockId: this.flockId
          })
        }
        this.swarm = null
        this.store = null
        if (this.onresolve) this._whenWritable()
        this.candidate.close().catch(noop)
      }
    })
  }

  _whenWritable () {
    if (this.flock.autobee.writable) return
    const check = () => {
      if (this.flock.autobee.writable) {
        this.flock.autobee.off('update', check)
        this.onresolve(this.flock)
      }
    }
    this.flock.autobee.on('update', check)
  }

  async _close () {
    if (this.candidate !== null) {
      await this.candidate.close()
    }

    if (this.swarm !== null) {
      await this.swarm.destroy()
    }

    if (this.store !== null) {
      await this.store.close()
    }

    if (this.onreject) {
      this.onreject(new Error('Pairing closed'))
    } else if (this.autobee) {
      await this.autobee.close()
    }
  }

  finished () {
    return new Promise((resolve, reject) => {
      this.onresolve = resolve
      this.onreject = reject
    })
  }
}

/**
 * @typedef {class} [Flock] - hold information and flock objects
 * @param {object} [opts] - pass optional info or hyper-objects
 * @param {string} [opts.storageDir] - Optional storage directory
 * @property {Object} [info] - flock info
 * @property {string} [flockId] -  flock identifier
 * @property {Autobee} [autobee] - Autobee instance
 * @property {Corestore} [corestore] - Corestore instance
 * @property {Hyperswarm} [swarm] - Hyperswarm instance
 * @property {BlindPairing} [pairing] - BlindPairing instance
 * @property {string} [invite] - invite code
 * @property {Object} [metadata] - flock metadata
 */

/**
 * Represents a single calendar flock for peer-planning
 * @extends EventEmitter
 */
class Flock extends ReadyResource {
  constructor (opts = {}) {
    super()
    this.info = opts.info || {}
    this.userData = opts.userData || {}
    this.flockId = opts.flockId || generateFlockId()
    this.key = opts.key
    this.isNew = opts.isNew

    this.corestore =
      opts.corestore ||
      (opts.storageDir
        ? new Corestore(opts.storageDir)
        : new Corestore(RAM.reusable()))
    this.bootstrap = opts.bootstrap
    this.swarm = opts.swarm || new Hyperswarm({ bootstrap: this.bootstrap })
    this.pairing = opts.pairing || new BlindPairing(this.swarm)
    this.member = null
    this.replicate = opts.replicate !== false
    this.autobee = null
    this.invite = ''
    this.myId = null

    this._boot(opts)
    this.ready()
  }

  _boot (opts = {}) {
    const { encryptionKey, key } = opts

    this.autobee =
      opts.autobee ||
      new Autobee(this.corestore, key, {
        encrypt: true,
        encryptionKey,
        apply,
        valueEncoding: c.any
      }).on('error', (err) =>
        console.error('An error occurred in Autobee:', err)
      )

    this.autobee.on('update', () => {
      if (!this.autobee._interrupting) this.emit('update')
    })
  }

  /**
   * Initializes the flock and sets up event handlers
   * @returns {Promise<string|void>} Returns invite code if flock is host
   */
  async _open () {
    if (!this.replicate) return
    await this.autobee.ready()
    this.myId = z32.encode(this.autobee.local.key)

    this.swarm.on('connection', async (conn) => {
      await this.corestore.replicate(conn)
    })
    this.pairing = new BlindPairing(this.swarm)
    this.member = this.pairing.addMember({
      discoveryKey: this.autobee.discoveryKey,
      onadd: (candidate) => this._onAddMember(candidate)
    })
    await this.member.flushed()
    this.opened = true
    this.invite = await this.createInvite()
    if (this.isNew) {
      const flockInfo = await this.autobee.get('flockInfo')

      if (flockInfo) {
        flockInfo.members = {
          ...flockInfo.members,
          [this.myId]: this.userData
        }
        this.info = flockInfo
      } else {
        this.info.members = {
          [this.myId]: this.userData
        }
      }

      await this.autobee.put('flockInfo', this.info)
    }
    this.emit('allDataThere')
    this._joinTopic()
  }

  async createInvite () {
    if (this.opened === false) await this.ready()
    const existing = await this.autobee.get('inviteInfo')
    if (existing) return existing.invite

    const { id, invite, publicKey, expires } = BlindPairing.createInvite(
      this.autobee.key
    )
    const record = {
      id: z32.encode(id),
      invite: z32.encode(invite),
      publicKey: z32.encode(publicKey),
      expires
    }
    await this.autobee.put('inviteInfo', record)
    return record.invite
  }

  async _onAddMember (candidate) {
    const id = z32.encode(candidate.inviteId)
    const inviteInfo = await this.autobee.get('inviteInfo')
    if (inviteInfo.id !== id) return

    candidate.open(z32.decode(inviteInfo.publicKey))
    await this._connectOtherCore(candidate.userData)
    candidate.confirm({
      key: this.autobee.key,
      encryptionKey: this.autobee.encryptionKey
    })
  }

  async _connectOtherCore (key) {
    await this.autobee.append({ type: 'addWriter', key })
    this.emit('peerEntered', z32.encode(key))
  }

  async _joinTopic () {
    try {
      const discovery = this.swarm.join(this.autobee.discoveryKey)
      await discovery.flushed()
    } catch (err) {
      console.error('Error joining swarm topic', err)
    }
  }

  async leave () {
    this.emit('leaveFlock')
    if (this.autobee.writable) {
      if (this.autobee.activeWriters.size > 1) {
        await this.autobee
          .append({
            type: 'removeWriter',
            key: this.autobee.local.key
          })
          .catch(this.exit())
        await this.exit()
      }
    }
  }

  async exit () {
    await this.member.close()
    await this.autobee.update()
    this.swarm.leave(this.autobee.discoveryKey)
    await this.autobee.close()
    this.emit('flockClosed')
  }

  isClosingDown () {
    return this.closingDown
  }
}

/**
 * Applies updates to autobee
 * @param {Array} batch - Array of nodes to process
 * @param {Object} view - View instance
 * @param {Object} base - Base instance
 * @returns {Promise<void>}
 */
async function apply (batch, view, base) {
  for (const node of batch) {
    const op = node.value

    // handling "updateSchedule" operation: update requests and schedule between shared peers
    if (op.type === 'newUser') {
      // TODO: add api to request a new change
      // TODO: add api to calculate free time for both parties (store their sharing calendar in autobee)
    }

    if (op.type === 'addWriter') {
      console.log('\rAdding writer', z32.encode(op.key))
      await base.addWriter(op.key)
      continue
    }

    if (op.type === 'removeWriter') {
      console.log('\rRemoving writer', z32.encode(op.key))
      await base.removeWriter(op.key)
      continue
    }
  }
  // Pass through to Autobee's default apply behavior
  await Autobee.apply(batch, view, base)
}

/**
 * Generates a unique flock identifier
 * @returns {string} Unique flock ID combining timestamp and random string
 */
function generateFlockId () {
  const timestamp = Date.now().toString(36) // Base36 timestamp
  const random = Math.random().toString(36).slice(2, 5) // 5 random chars
  return `flock-${timestamp}-${random}`
}

/**
 * Hyperbee implementation for Autobase
 */
class Autobee extends Autobase {
  constructor (store, bootstrap, handlers = {}) {
    if (
      bootstrap &&
      typeof bootstrap !== 'string' &&
      !b4a.isBuffer(bootstrap)
    ) {
      handlers = bootstrap
      bootstrap = null
    }

    const open = (viewStore) => {
      const core = viewStore.get('autobee')
      return new Hyperbee(core, {
        ...handlers,
        extension: false
      })
    }

    const apply = 'apply' in handlers ? handlers.apply : Autobee.apply

    super(store, bootstrap, { ...handlers, open, apply })
    this.eventEmitter = new EventEmitter()
  }

  static async apply (batch, view, base) {
    const b = view.batch({ update: false })
    // Decode operation node key if the Hyperbee view has a keyEncoding set & it
    // wasn't already decoded.
    const decodeKey = (x) =>
      b4a.isBuffer(x) && view.keyEncoding ? view.keyEncoding.decode(x) : x

    // Process operation nodes
    for (const node of batch) {
      const op = node.value
      if (op.type === 'put') {
        const encKey = decodeKey(op.key)
        await b.put(encKey, op.value, op.opts)
      } else if (op.type === 'del') {
        const encKey = decodeKey(op.key)
        await b.del(encKey, op.opts)
      }
    }

    await b.flush()
  }

  _getEncodedKey (key, opts) {
    // Apply keyEncoding option if provided.
    // The key is preencoded so that the encoding survives being deserialized
    // from the input core
    const encKey = opts && opts.keyEncoding ? opts.keyEncoding.encode(key) : key

    // Clear keyEncoding from options as it has now been applied
    if (opts && opts.keyEncoding) {
      delete opts.keyEncoding
    }

    return encKey
  }

  put (key, value, opts) {
    return this.append({
      type: 'put',
      key: this._getEncodedKey(key, opts),
      value,
      opts
    })
  }

  del (key, opts) {
    return this.append({
      type: 'del',
      key: this._getEncodedKey(key, opts),
      opts
    })
  }

  async get (key, opts) {
    // do I have to await??
    const node = await this.view.get(key, opts)
    if (node === null) return null
    return node.value
  }

  peek (opts) {
    return this.view.peek(opts)
  }

  createReadStream (range, opts) {
    return this.view.createReadStream(range, opts)
  }
}

// serialize nested Map to JSON
function mapToJson (map) {
  return JSON.stringify(
    [...map].map(([key, val]) => [
      key,
      val instanceof Map
        ? mapToJson(val)
        : val instanceof Date
          ? val.toISOString()
          : val
    ])
  )
}

// deserialize JSON back to a nested Map, handling Date objects
function jsonToMap (jsonStr) {
  return new Map(
    JSON.parse(jsonStr).map(([key, val]) => [
      key,
      typeof val === 'string' && val.startsWith('[')
        ? jsonToMap(val) // Recurse for nested Map
        : typeof val === 'string' &&
            /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/.test(val)
          ? new Date(val) // Convert string to Date
          : val
    ])
  )
}

function noop () {}

module.exports = FlockManager
