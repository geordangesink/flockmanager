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
 * @property {Hyperbee} [flocksBee] - local hyperbee for personal storage (for now)
 * @property {Hyperswarm} [swarm] - Hyperswarm instance
 * @property {BlindPairing} [pairing] - BlindPairing instance
 * @property {Object} [flocks] - Id key and flock instance value
 * @property {Set} [discoveryKeys] - joined flocks dicovery keys
 */
class FlockManager extends ReadyResource {
  constructor (storageDir, opts = {}) {
    super()
    this.storageDir = storageDir || './storage'
    this.corestore = new Corestore(this.storageDir)
    this.flocksBee = null
    this.localBee = null
    this.keyPair = null
    this.bootstrap = opts.bootstrap || null
    this.swarm = new Hyperswarm({ bootstrap: this.bootstrap })
    this.pairing = new BlindPairing(this.swarm)
    this.isSaving = false
    this.flocks = {}
    this._userData = {}
    this.discoveryKeys = new Set()
    this.ready().catch(noop)
  }

  get userData () {
    return this._userData
  }

  async _open () {
    await this.corestore.ready()
    this.keyPair = await this.corestore.createKeyPair('flockManager')
    this.flocksBee = new Hyperbee(
      this.corestore.namespace('localData').get({ name: 'flocksBee' }),
      {
        keyEncoding: 'utf-8',
        valueEncoding: c.any
      }
    )
    await this.flocksBee.ready()
    this.localBee = new Hyperbee(
      this.corestore.namespace('localData').get({ name: 'localBee' }),
      {
        keyEncoding: 'utf-8',
        valueEncoding: c.any
      }
    )
    await this.localBee.ready()

    const flocksInfo = await this.flocksBee.get('flocksInfo')
    const userDataDb = await this.localBee.get('userData')

    if (flocksInfo && flocksInfo.value) {
      const flocksInfoMap = jsonToMap(flocksInfo.value.toString())
      const userData = (userDataDb && userDataDb.value) || {}
      this._userData = userData
      for (const [localId, infoMap] of flocksInfoMap) {
        const custom = infoMap.get('custom')
        await this.initFlock(undefined, { custom, localId, userData }, false)
      }
    } else {
      await this.flocksBee.put('flocksInfo', mapToJson(new Map()))
    }
  }

  /**
   * set userData across all flocks
   * @param {Object} userData
   */
  async setUserData (userData) {
    try {
      if (typeof userData !== 'object') throw new Error('userData must be typeof Object', TypeError)
      await this.localBee.put('userData', userData)
      for await (const flock of Object.values(this.flocks)) {
        flock._setUserData(userData)
      }
    } catch (err) {
      throw new Error(`Error in updating userData: ${err}`)
    }
  }

  /**
   * save local data
   * @param {string}
   * @param {*}
   */
  async set (string, data) {
    if (string === 'userData') return this.setUserData(data)
    try {
      let newData = data
      // TODO: check if map can be handled without parsing
      if (newData instanceof Map) newData = mapToJson(data)
      await this.localBee.put(string, newData)
    } catch (err) {
      throw new Error(`Error in updating local storage: ${err}`)
    }
  }

  /**
   * get local data
   * @param {string}
   * @returns {Promise}
   */
  async get (string) {
    try {
      const rawData = await this.localBee.get(string)
      const data = rawData && rawData.value
      // TODO: check if map can be handled without parsing
      if (typeof data === 'string') {
        try {
          const parsed = jsonToMap(data)
          return parsed
        } catch {
          noop()
        }
      }
      return data
    } catch (err) {
      throw new Error(`Error in getting "${string}": ${err}`)
    }
  }

  /**
   * gets configuration options for a flock
   * @param {string} localId - Unique flock identifier
   * @returns {Object} flock configuration options
   */
  getFlockOptions (localId) {
    const corestore = localId ? this.corestore.namespace(localId) : this.corestore
    return { corestore, swarm: this.swarm, pairing: this.pairing }
  }

  /**
   * return an alias stream of flock's corestore namespace
   * @param {Flock} flock - flock instance
   * @returns {stream} - stream of hypercores within the flocks namespace
   */
  getFlockCoresStream (flock) {
    const namespace = flock.corestore.ns
    const stream = flock.corestore.storage.createAliasStream(namespace)
    return stream
  }

  /**
   * create or join a new flock and add to db
   * @param {string} [invite] - Optional input invite
   * @param {Object} [opts={}] - flock configuration options
   * @param {boolean} [isNew] - tries to open existing flock if false
   * @returns {Flock || false} New flock instance or false on invalid invite
   */
  async initFlock (invite = '', opts = {}, isNew = true) {
    let flock
    const localId = opts.localId || generateLocalId()
    const baseOpts = { ...opts, localId, ...this.getFlockOptions(localId), userData: this._userData, isNew }
    if (invite) {
      // check for invalid invite or already joined
      const discoveryKey = await this.getDiscoveryKey(invite)
      if (discoveryKey === 'invalid') return false
      else if (discoveryKey) return this.findFlock(discoveryKey)

      const pair = FlockManager.pair(invite, baseOpts)
      flock = await pair.finished()
      flock.on('leaveflock', () => this._deleteFlock(flock))
      if (isNew) flock.on('allDataThere', () => this.saveFlock(flock))
    } else {
      flock = new Flock(baseOpts)
      flock.on('leaveflock', () => this._deleteFlock(flock))
      if (isNew) flock.on('allDataThere', () => this.saveFlock(flock))
      await flock.ready()
    }

    this.flocks[localId] = flock
    flock.on('flockClosed', () => {
      if (this.closingDown) return
      delete this.flocks[localId]
      if (Object.keys(this.flocks).length > 0) return
      this.emit('lastFlockClosed')
    })
    this.emit('newFlock', flock)

    if (!this.discoveryKeys.has(flock.discoveryKey)) { this.discoveryKeys.add(flock.discoveryKey) }

    return flock
  }

  /**
   * to join an existing flock
   * @param {Object} opts
   * @returns {FlockPairer} - pairs flocks. await flockPairer.finished() to return joined flock
   */
  static pair (invite, opts = {}) {
    const store = opts.corestore
    return new FlockPairer(store, invite, opts)
  }

  /**
   * get the discovery key of an existing flock by its invite key
   * @param {string} invite
   * @returns {string} - discoveryKey or "invalid"
   */
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

  async _deleteFlock (flock) {
    const stream = this.getFlockCoresStream(flock)

    stream.on('data', async (data) => {
      try {
        const core = this.corestore.get(data.discoveryKey)
        await core.ready()
        await core.purge()
      } catch (err) {
        throw new Error(`Error in purging hypercore: ${err}`)
      }
    })

    stream.on('end', () => {
      console.log('flock purge stream ended.')
    })

    const flocksInfoDb = await this.flocksBee.get('flocksInfo')
    const flocksInfoMap = flocksInfoDb
      ? jsonToMap(flocksInfoDb.value.toString())
      : new Map()

    if (flocksInfoMap.has(flock.localId)) {
      flocksInfoMap.delete(flock.localId)
      await this.flocksBee.put('flocksInfo', Buffer.from(mapToJson(flocksInfoMap)))
    }
  }

  /**
   *  store folder key and flock id in personal db
   * @param {Flock}
   */
  async saveFlock (flock) {
    if (this.closingDown) return
    this.isSaving = true
    try {
      const flocksInfoDb = await this.flocksBee.get('flocksInfo')
      const flocksInfoMap = flocksInfoDb
        ? jsonToMap(flocksInfoDb.value.toString())
        : new Map()
      if (!flocksInfoMap.has(flock.localId)) {
        const detailsMap = new Map([['custom', flock.custom]])
        flocksInfoMap.set(flock.localId, detailsMap)
        await this.flocksBee.put('flocksInfo', Buffer.from(mapToJson(flocksInfoMap)))
      }
    } catch (err) {
      throw new Error(`Error in saving flock info to local db: ${err}`)
    } finally {
      this.isSaving = false
    }
  }

  /**
   * Find a flock with its descoveryKey
   * @param {string}
   * @returns {Flock}
   */
  async findFlock (discoveryKey) {
    for (const localId in this.flocks) {
      if (
        z32.encode(this.flocks[localId].metadata.discoveryKey) === discoveryKey
      ) {
        return this.flocks[localId]
      }
    }
  }

  async cleanup () {
    if (this.isSaving) {
      // Wait for the saving to complete before closing
      await new Promise(resolve => {
        const checkSaving = setInterval(() => {
          if (!this.isSaving) {
            clearInterval(checkSaving)
            resolve()
          }
        }, 100)
      })
    }
    this.closingDown = true
    const exitPromises = Object.values(this.flocks).map((flock) => flock._exit())
    await Promise.all(exitPromises)
    this.flocks = {}

    // Clean up other resources
    await this.localBee.close()
    await this.flocksBee.close()
    await this.pairing.close()
    await this.swarm.destroy()
    await this.corestore.close()
    this.closingDown = false
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
    this.localId = opts.localId
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
            localId: this.localId
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
 * @property {string} [localId] -  flock identifier
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
    this.custom = opts.custom
    this._info = opts.info || {}
    this._userData = opts.userData || {}
    this._localId = opts.localId || generateLocalId()
    this._keyPair = null
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

  get info () {
    return this._info
  }

  get userData () {
    return this._userData
  }

  get localId () {
    return this._localId
  }

  get keyPair () {
    return this._keyPair
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
      this._updateInfo()
      if (!this.autobee._interrupting) this.emit('update')
    })
  }

  /**
   * Initializes the flock and sets up event handlers
   * @returns {Promise<string|void>} Returns invite code if flock is host
   */
  async _open () {
    this._keyPair = await this.corestore.createKeyPair('awesome')
    if (!this.replicate) return
    await this.autobee.ready()
    await this._updateInfo()
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
    this.invite = await this._createInvite().catch(noop)
    if (this.isNew) {
      this._setUserData().catch(noop)
    }
    this.emit('allDataThere')
    this._joinTopic()
  }

  async _createInvite () {
    if (this.opened === false) await this.ready()
    const existing = await this.get('inviteInfo')
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
    await this.set('inviteInfo', record, { encryptionKey: this.keyPair.secretKey })
    return record.invite
  }

  async _onAddMember (candidate) {
    const id = z32.encode(candidate.inviteId)
    const inviteInfo = await this.get('inviteInfo')
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
      throw new Error(`Error joining swarm topic: ${err}`)
    }
  }

  /**
   * set flock data
   * @param {string} [key]
   * @param {*} [data]
   * @param {Buffer} [encryptionKey] - encryption key (eg. this.keyPair.secretKey)
   */
  async set (key, data, encryptionKey = null) {
    if (key.startsWith('flockInfo/members/')) return this._setUserData(data)
    try {
      let newData = data
      // TODO: check if map can be handled without parsing
      if (newData instanceof Map) newData = mapToJson(newData)
      await this.autobee.put(key, newData, { encryptionKey })
    } catch (err) {
      throw new Error(`Error in updating local storage: ${err}`)
    }
  }

  /**
   * get flock data
   * @param {string} [key]
   * @returns {Promise}
   */
  async get (key) {
    try {
      const data = await this.autobee.get(key)
      // TODO: check if map can be handled without parsing
      if (typeof data === 'string') {
        try {
          const parsed = jsonToMap(data)
          return parsed
        } catch {
          noop()
        }
      }
      return data
    } catch (err) {
      throw new Error(`Error in getting "${key}": ${err}`)
    }
  }

  async getByPrefix (prefix) {
    try {
      const stream = this.autobee.createReadStream({
        gte: Buffer.from(prefix),
        lte: Buffer.from(prefix + '\xFF')
      })

      const result = {} // flockInfo/
      const nestObject = (obj, path, value) => {
        const keys = path.split('/')
        let current = obj

        keys.forEach((key, index) => {
          if (index !== keys.length - 1) {
            current[key] = current[key] || {}
          } else {
            current[key] = value || current[key] || {}
          }
          current = current[key]
        })
      }
      for await (const { key, value } of stream) {
        const keyParsed = key.toString()
        const valueParsed = b4a.isBuffer(value) ? value.toString() : value
        let path = keyParsed.substring(prefix.length)
        if (path.startsWith('/')) path = path.substring(1)

        nestObject(result, path, valueParsed)
      }

      return result
    } catch (err) {
      throw new Error(`Error in getting all Prefix: ${err}`)
    }
  }

  async _setUserData (userData) {
    try {
      if (userData && typeof userData !== 'object') throw new Error('userData must be typeof Object', TypeError)
      if (userData) this._userData = userData
      const flockInfo = await this.getByPrefix('flockInfo/')

      if (flockInfo) {
        flockInfo.members = {
          ...flockInfo.members,
          [this.myId]: this._userData
        }
        this._info = flockInfo
      } else {
        this._info.members = {
          [this.myId]: this._userData
        }
      }

      await this.autobee.put(`flockInfo/members/${this.myId}`, userData, { encryptionKey: this.keyPair.secretKey })
    } catch (err) {
      throw new Error(`Error in updating flock ${this.localId} userData: ${err}`)
    }
  }

  async _updateInfo () {
    const info = await this.getByPrefix('flockInfo/')
    this._info = info
  }

  async leave () {
    if (this.autobee.writable) {
      if (this.autobee.activeWriters.size > 1) {
        await this.autobee
          .append({
            type: 'removeWriter',
            key: this.autobee.local.key
          })
          .catch(this._exit())
        await this._exit()
      }
    }
    this.emit('leaveFlock')
  }

  async _exit () {
    await this.member.close()
    await this.swarm.leave(this.autobee.discoveryKey)
    await this.autobee.close()
    this.emit('flockClosed')
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
function generateLocalId () {
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
