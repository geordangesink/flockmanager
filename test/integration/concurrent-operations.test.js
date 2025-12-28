const test = require('brittle')
const FlockManager = require('../..')
const testnet = require('hyperdht/testnet')
const tmp = require('test-tmp')
const { installChaos } = require('../helpers/chaos')

const DEFAULT_TIMEOUT = 20000

test('manager handles multiple flocks concurrently', async function (t) {
  const tn = await testnet(10, t)
  const managerA = await createManager(t, { bootstrap: tn.bootstrap })
  const managerB = await createManager(t, { bootstrap: tn.bootstrap })

  const flocksA = await Promise.all([
    managerA.create(),
    managerA.create(),
    managerA.create()
  ])
  const invites = flocksA.map((flock) => flock.invite)
  const flocksB = await Promise.all(invites.map((invite) => managerB.create(invite)))

  await Promise.all([
    ...flocksA.map((flock) => waitForMembers(flock, 2)),
    ...flocksB.map((flock) => waitForMembers(flock, 2))
  ])

  await Promise.all(
    flocksA.map((flock, index) =>
      flock.set(`shared/flock-${index}`, `value-${index}`)
    )
  )

  await Promise.all(
    flocksB.map((flock, index) =>
      waitForValue(flock, `shared/flock-${index}`, `value-${index}`)
    )
  )

  for (let i = 0; i < flocksB.length; i += 1) {
    t.is(await flocksB[i].get(`shared/flock-${i}`), `value-${i}`)
  }
})

test('concurrent writes to different keys do not conflict', async function (t) {
  const { flocks } = await createPeerCluster(t, 3)

  await Promise.all(flocks.map((flock) => waitForMembers(flock, 3)))

  await Promise.all([
    flocks[0].set('keys/alpha', 'one'),
    flocks[1].set('keys/bravo', 'two'),
    flocks[2].set('keys/charlie', 'three')
  ])

  await Promise.all(
    flocks.map((flock) =>
      waitForPrefixValues(flock, 'keys/', {
        alpha: 'one',
        bravo: 'two',
        charlie: 'three'
      })
    )
  )

  for (const flock of flocks) {
    const keys = await flock.getByPrefix('keys/')
    t.is(keys.alpha, 'one')
    t.is(keys.bravo, 'two')
    t.is(keys.charlie, 'three')
  }
})

test('concurrent writes to same key converge', async function (t) {
  const { flocks } = await createPeerCluster(t, 3)
  const values = ['alpha', 'bravo', 'charlie']

  await Promise.all(flocks.map((flock) => waitForMembers(flock, 3)))

  await Promise.all(
    flocks.map((flock, index) => flock.set('shared/race', values[index]))
  )

  const winner = await waitForConvergence(flocks, 'shared/race', values)
  const results = await Promise.all(flocks.map((flock) => flock.get('shared/race')))

  t.ok(values.includes(winner))
  t.ok(results.every((value) => value === winner))
})

test('peers join simultaneously via same invite', async function (t) {
  const tn = await testnet(10, t)
  const managerA = await createManager(t, { bootstrap: tn.bootstrap })
  const host = await managerA.create()

  const managerB = await createManager(t, { bootstrap: tn.bootstrap })
  const managerC = await createManager(t, { bootstrap: tn.bootstrap })
  const managerD = await createManager(t, { bootstrap: tn.bootstrap })

  const [flockB, flockC, flockD] = await Promise.all([
    managerB.create(host.invite),
    managerC.create(host.invite),
    managerD.create(host.invite)
  ])

  await Promise.all([
    waitForMembers(host, 4),
    waitForMembers(flockB, 4),
    waitForMembers(flockC, 4),
    waitForMembers(flockD, 4)
  ])

  t.is(host.autobee.system.members, 4)
  t.is(flockB.autobee.system.members, 4)
  t.is(flockC.autobee.system.members, 4)
  t.is(flockD.autobee.system.members, 4)
})

test('setUserData propagates across multiple flocks', async function (t) {
  const tn = await testnet(10, t)
  const managerA = await createManager(t, { bootstrap: tn.bootstrap })
  const managerB = await createManager(t, { bootstrap: tn.bootstrap })

  const flocksA = await Promise.all([managerA.create(), managerA.create()])
  const invites = flocksA.map((flock) => flock.invite)
  const flocksB = await Promise.all(invites.map((invite) => managerB.create(invite)))

  await Promise.all([
    ...flocksA.map((flock) => waitForMembers(flock, 2)),
    ...flocksB.map((flock) => waitForMembers(flock, 2))
  ])

  await managerA.setUserData({ name: 'alpha', team: 'core' })

  await Promise.all(
    flocksB.map((flock) => waitForUserData(flock, 'alpha'))
  )

  for (const flock of flocksB) {
    const data = await flock.getByPrefix('flockInfo/')
    const members = (data && data.members) || {}
    const names = Object.values(members).map((userData) => userData && userData.name)
    t.ok(names.includes('alpha'))
  }
})

async function createPeerCluster (t, count) {
  const tn = await testnet(10, t)
  const managers = []

  for (let i = 0; i < count; i += 1) {
    managers.push(await createManager(t, { bootstrap: tn.bootstrap }))
  }

  const flocks = []
  const host = await managers[0].create()
  flocks.push(host)

  const invite = host.invite
  for (let i = 1; i < count; i += 1) {
    flocks.push(await managers[i].create(invite))
  }

  return { tn, managers, flocks, invite }
}

async function createManager (t, opts) {
  const dir = await tmp(t)
  const manager = new FlockManager(dir, opts)
  await manager.ready()
  installChaos(t, manager)
  t.teardown(async () => {
    await manager.close()
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

function waitForPrefixValues (flock, prefix, expected) {
  return waitForUpdate(
    flock,
    async () => {
      const data = await flock.getByPrefix(prefix)
      return Object.keys(expected).every((key) => data[key] === expected[key])
    },
    `prefix:${prefix}`
  )
}

function waitForUserData (flock, name) {
  return waitForUpdate(
    flock,
    async () => {
      const data = await flock.getByPrefix('flockInfo/')
      const members = (data && data.members) || {}
      return Object.values(members).some((userData) => userData && userData.name === name)
    },
    `userData:${name}`
  )
}

async function waitForConvergence (flocks, key, expectedValues) {
  const start = Date.now()
  while (Date.now() - start < DEFAULT_TIMEOUT) {
    const values = await Promise.all(flocks.map((flock) => flock.get(key)))
    const allEqual = values.every((value) => value === values[0])
    if (allEqual && expectedValues.includes(values[0])) return values[0]
    await sleep(200)
  }
  throw new Error(`timeout waiting for convergence on ${key}`)
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
