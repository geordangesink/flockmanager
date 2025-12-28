const { randomBytes } = require('crypto')

const DEFAULTS = {
  connectionDelayMin: 10,
  connectionDelayMax: 120,
  writeDelayMin: 0,
  writeDelayMax: 20,
  readDelayMin: 0,
  readDelayMax: 20,
  dropRate: 0.02,
  dropDelayMin: 200,
  dropDelayMax: 600,
  partitionRate: 0.1,
  partitionDelayMin: 300,
  partitionDelayMax: 1000,
  partitionDownMin: 250,
  partitionDownMax: 800,
  graceMs: 1500
}

let cachedChaos

function installChaos (t, manager) {
  const chaos = getChaos(t)
  if (!chaos) return null

  applyChaosToSwarm(manager.swarm, chaos)

  if (!manager._chaosCreateWrapped) {
    const originalCreate = manager.create.bind(manager)
    manager.create = async (...args) => {
      const flock = await originalCreate(...args)
      if (flock) applyChaosToFlock(flock, chaos)
      return flock
    }
    manager._chaosCreateWrapped = true
  }

  return chaos
}

function enableChaos (t) {
  const chaos = getChaos(t)
  if (!chaos) return null
  if (chaos.enabled) return chaos

  chaos.enabled = true
  chaos.enabledAt = Date.now()
  chaos.epoch += 1

  for (const swarm of chaos.swarms) {
    for (const conn of swarm.connections) {
      applyConnectionChaos(conn, chaos)
    }
  }

  for (const flock of chaos.flocks) {
    schedulePartition(flock, chaos)
  }

  registerTeardown(t, chaos)
  return chaos
}

function getChaos (t) {
  if (cachedChaos !== undefined) return cachedChaos
  if (!isEnabled()) {
    cachedChaos = null
    return null
  }

  const seed = getSeed()
  const rng = createRng(seed)
  const opts = readOptions()

  cachedChaos = {
    seed,
    rng,
    opts,
    enabled: false,
    enabledAt: null,
    epoch: 0,
    swarms: new Set(),
    flocks: new Set(),
    timers: new Set(),
    teardownTests: new WeakSet(),
    logged: false
  }

  if (t && !cachedChaos.logged) {
    t.comment(`chaos seed: ${seed}`)
    cachedChaos.logged = true
  }

  return cachedChaos
}

function applyChaosToSwarm (swarm, chaos) {
  if (!swarm || swarm._chaosPatched) return
  swarm._chaosPatched = true
  chaos.swarms.add(swarm)

  const originalEmit = swarm.emit
  swarm.emit = function (event, ...args) {
    if (event === 'connection' && args[0]) {
      const conn = args[0]
      if (!chaos.enabled) return originalEmit.apply(this, [event, ...args])
      applyConnectionChaos(conn, chaos)

      const delay = randRange(chaos.rng, chaos.opts.connectionDelayMin, chaos.opts.connectionDelayMax)
      if (delay > 0) {
        setChaosTimeout(chaos, () => {
          originalEmit.apply(this, [event, ...args])
        }, delay)
        return this.listenerCount(event) > 0
      }
    }

    return originalEmit.apply(this, [event, ...args])
  }
}

function applyChaosToFlock (flock, chaos) {
  if (!flock || flock._chaosPatched) return
  flock._chaosPatched = true
  chaos.flocks.add(flock)
  if (chaos.enabled) schedulePartition(flock, chaos)
}

function applyConnectionChaos (conn, chaos) {
  if (!conn || conn._chaosPatched) return
  conn._chaosPatched = true

  if (chaos.opts.readDelayMax > 0) {
    const onData = () => {
      if (!chaos.enabled) return
      const delay = randRange(chaos.rng, chaos.opts.readDelayMin, chaos.opts.readDelayMax)
      if (delay <= 0) return
      conn.pause()
      setChaosTimeout(chaos, () => conn.resume(), delay)
    }

    conn.on('data', onData)
    conn.on('close', () => conn.removeListener('data', onData))
  }

  if (chaos.opts.writeDelayMax > 0) {
    const originalWrite = conn.write.bind(conn)
    conn.write = (chunk, encoding, cb) => {
      if (typeof encoding === 'function') {
        cb = encoding
        encoding = null
      }

      if (!chaos.enabled) return originalWrite(chunk, encoding, cb)
      const delay = randRange(chaos.rng, chaos.opts.writeDelayMin, chaos.opts.writeDelayMax)
      if (delay <= 0) return originalWrite(chunk, encoding, cb)

      setChaosTimeout(chaos, () => {
        if (!chaos.enabled) return
        originalWrite(chunk, encoding, cb)
      }, delay)

      return true
    }
  }

  if (shouldDrop(chaos) && chaos.rng() < chaos.opts.dropRate) {
    const delay = randRange(chaos.rng, chaos.opts.dropDelayMin, chaos.opts.dropDelayMax)
    setChaosTimeout(chaos, () => {
      if (!chaos.enabled) return
      conn.destroy()
    }, delay)
  }
}

function registerTeardown (t, chaos) {
  if (!t) return
  if (chaos.teardownTests.has(t)) return
  chaos.teardownTests.add(t)
  t.teardown(() => {
    for (const timer of chaos.timers) clearTimeout(timer)
    chaos.timers.clear()
    chaos.enabled = false
    chaos.enabledAt = null
  })
}

function setChaosTimeout (chaos, fn, ms) {
  const timer = setTimeout(() => {
    chaos.timers.delete(timer)
    fn()
  }, ms)
  chaos.timers.add(timer)
  return timer
}

function isEnabled () {
  return process.env.FLOCK_CHAOS === '1' || process.env.FLOCK_CHAOS === 'true'
}

function getSeed () {
  const fromEnv = Number.parseInt(process.env.FLOCK_CHAOS_SEED, 10)
  if (Number.isInteger(fromEnv)) return fromEnv
  return randomBytes(4).readUInt32LE(0)
}

function createRng (seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function readOptions () {
  return {
    connectionDelayMin: readInt('FLOCK_CHAOS_CONN_MIN', DEFAULTS.connectionDelayMin),
    connectionDelayMax: readInt('FLOCK_CHAOS_CONN_MAX', DEFAULTS.connectionDelayMax),
    writeDelayMin: readInt('FLOCK_CHAOS_WRITE_MIN', DEFAULTS.writeDelayMin),
    writeDelayMax: readInt('FLOCK_CHAOS_WRITE_MAX', DEFAULTS.writeDelayMax),
    readDelayMin: readInt('FLOCK_CHAOS_READ_MIN', DEFAULTS.readDelayMin),
    readDelayMax: readInt('FLOCK_CHAOS_READ_MAX', DEFAULTS.readDelayMax),
    dropRate: readFloat('FLOCK_CHAOS_DROP_RATE', DEFAULTS.dropRate),
    dropDelayMin: readInt('FLOCK_CHAOS_DROP_MIN', DEFAULTS.dropDelayMin),
    dropDelayMax: readInt('FLOCK_CHAOS_DROP_MAX', DEFAULTS.dropDelayMax),
    partitionRate: readFloat('FLOCK_CHAOS_PARTITION_RATE', DEFAULTS.partitionRate),
    partitionDelayMin: readInt('FLOCK_CHAOS_PARTITION_MIN', DEFAULTS.partitionDelayMin),
    partitionDelayMax: readInt('FLOCK_CHAOS_PARTITION_MAX', DEFAULTS.partitionDelayMax),
    partitionDownMin: readInt('FLOCK_CHAOS_PARTITION_DOWN_MIN', DEFAULTS.partitionDownMin),
    partitionDownMax: readInt('FLOCK_CHAOS_PARTITION_DOWN_MAX', DEFAULTS.partitionDownMax),
    graceMs: readInt('FLOCK_CHAOS_GRACE_MS', DEFAULTS.graceMs)
  }
}

function readInt (name, fallback) {
  const value = Number.parseInt(process.env[name], 10)
  return Number.isFinite(value) ? value : fallback
}

function readFloat (name, fallback) {
  const value = Number.parseFloat(process.env[name])
  return Number.isFinite(value) ? value : fallback
}

function randRange (rng, min, max) {
  if (max <= min) return min
  return min + Math.floor(rng() * (max - min + 1))
}

function schedulePartition (flock, chaos) {
  if (!chaos.enabled) return
  if (flock._chaosPartitionEpoch === chaos.epoch) return
  flock._chaosPartitionEpoch = chaos.epoch

  if (chaos.rng() >= chaos.opts.partitionRate) return

  const startDelay = randRange(chaos.rng, chaos.opts.partitionDelayMin, chaos.opts.partitionDelayMax)
  const downDelay = randRange(chaos.rng, chaos.opts.partitionDownMin, chaos.opts.partitionDownMax)
  const extraDelay = graceDelay(chaos)

  setChaosTimeout(chaos, async () => {
    if (!chaos.enabled) return
    try {
      await flock.swarm.leave(flock.autobee.discoveryKey)
    } catch {}

    setChaosTimeout(chaos, async () => {
      if (!chaos.enabled) return
      try {
        const discovery = flock.swarm.join(flock.autobee.discoveryKey)
        await discovery.flushed()
      } catch {}
    }, downDelay)
  }, startDelay + extraDelay)
}

function shouldDrop (chaos) {
  if (!chaos.enabled) return false
  if (!chaos.enabledAt || chaos.opts.graceMs <= 0) return true
  return Date.now() - chaos.enabledAt >= chaos.opts.graceMs
}

function graceDelay (chaos) {
  if (!chaos.enabledAt || chaos.opts.graceMs <= 0) return 0
  const elapsed = Date.now() - chaos.enabledAt
  return elapsed >= chaos.opts.graceMs ? 0 : chaos.opts.graceMs - elapsed
}

module.exports = { installChaos, enableChaos }
