const test = require('brittle')
const FlockManager = require('../..')
const testnet = require('hyperdht/testnet')
const tmp = require('test-tmp')
const { installChaos } = require('../helpers/chaos')

const DEFAULT_TIMEOUT = 20000

test('peer leaves and rejoins swarm, resumes sync', async function (t) {
  const tn = await testnet(10, t)
  const managerA = await createManager(t, { bootstrap: tn.bootstrap })
  const managerB = await createManager(t, { bootstrap: tn.bootstrap })

  const flockA = await managerA.create()
  const flockB = await managerB.create(flockA.invite)

  await Promise.all([waitForMembers(flockA, 2), waitForMembers(flockB, 2)])

  await flockB.swarm.leave(flockB.autobee.discoveryKey)
  await sleep(300)

  await flockA.set('shared/offline', 'queued')

  const discovery = flockB.swarm.join(flockB.autobee.discoveryKey)
  await discovery.flushed()

  await waitForValue(flockB, 'shared/offline', 'queued')
  t.is(await flockB.get('shared/offline'), 'queued')
})

test('local writes succeed while swarm is offline', async function (t) {
  const tn = await testnet(10, t)
  const manager = await createManager(t, { bootstrap: tn.bootstrap })
  const flock = await manager.create()

  await flock.swarm.leave(flock.autobee.discoveryKey)
  await flock.set('local/offline', 'ok')

  t.is(await flock.get('local/offline'), 'ok')
})

test('manager handles unreachable bootstrap without crashing', async function (t) {
  const badBootstrap = [{ host: '127.0.0.1', port: 65530 }]
  const manager = await createManager(t, { bootstrap: badBootstrap })
  const flock = await manager.create()

  await flock.set('local/bootstrap', 'ok')
  t.is(await flock.get('local/bootstrap'), 'ok')
})

async function createManager (t, opts) {
  const dir = await tmp(t)
  const manager = new FlockManager(dir, opts)
  await manager.ready()
  installChaos(t, manager)
  t.teardown(async () => {
    try {
      await manager.close()
    } catch {
      // Swarm may already be closed in resilience tests.
    }
  })
  return manager
}

function waitForMembers (flock, expected) {
  return waitForUpdate(
    flock,
    () => flock.autobee.system.members >= expected,
    `members=${expected}`
  )
}

function waitForValue (flock, key, expected) {
  return waitForUpdate(
    flock,
    async () => (await flock.get(key)) === expected,
    `value:${key}`
  )
}

function waitForUpdate (flock, predicate, label) {
  return new Promise((resolve, reject) => {
    let timeout = null

    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      flock.removeListener('update', onUpdate)
    }

    const onUpdate = async () => {
      try {
        const ok = await predicate()
        if (!ok) return
        cleanup()
        resolve()
      } catch (err) {
        cleanup()
        reject(err)
      }
    }

    timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`timeout waiting for ${label}`))
    }, DEFAULT_TIMEOUT)

    flock.on('update', onUpdate)
    onUpdate()
  })
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
