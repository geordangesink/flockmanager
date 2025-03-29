const test = require('brittle')
const FlockManager = require('./')
const testnet = require('hyperdht/testnet')
const tmp = require('test-tmp')

test('basic', async function (t) {
  const a = await create(t)

  a.set('ping', 'pong')

  const flock = await a.initFlock()
  await flock.set('hello', 'world')

  t.ok(flock.autobee.encryptionKey)
  t.is(await flock.get('hello'), 'world')
  t.is(await a.get('ping'), 'pong')
})

test('invites', async function (t) {
  t.plan(2)

  const tn = await testnet(10, t)

  const a = await create(t, { bootstrap: tn.bootstrap })
  const flockA = await a.initFlock()

  let passedA = false
  flockA.on('update', async function onUpdate () {
    if (flockA.autobee.system.members === 2) {
      if (!passedA) t.pass('a has two members')
      passedA = true
    }
  })

  const inv = flockA.invite

  const b = await create(t, { bootstrap: tn.bootstrap })
  const flockB = await b.initFlock(inv)

  let passedB = false
  flockB.on('update', async function onUpdate () {
    if (flockB.autobee.system.members === 2) {
      if (!passedB) t.pass('b has two members')
      passedB = true
    }
  })
})

test('userData updates', async function (t) {
  t.plan(1)
  const tn = await testnet(10, t)

  const a = await create(t, { bootstrap: tn.bootstrap })
  const flockA = await a.initFlock()

  const inv = flockA.invite

  const b = await create(t, { bootstrap: tn.bootstrap })
  const flockB = await b.initFlock(inv)

  await a.setUserData({ hello: 'world' })

  let passed = false
  flockB.on('update', async function onUpdate () {
    const data = await flockB.getByPrefix('flockInfo/')
    if (Object.values(data.members).some(userData => userData.hello === 'world')) {
      if (!passed)t.pass('b received updated userData')
      passed = true
    }
  })
})

test('userData encryption', async function (t) {
  t.plan(2)
  const tn = await testnet(10, t)

  const a = await create(t, { bootstrap: tn.bootstrap })
  const flockA = await a.initFlock()

  const inv = flockA.invite

  const b = await create(t, { bootstrap: tn.bootstrap })
  const flockB = await b.initFlock(inv)

  await a.setUserData({ hello: 'world' })

  let okPassed = false
  let passed = false
  flockB.on('update', async function onUpdate () {
    const data = await flockB.getByPrefix('flockInfo/')
    for (const userId in data.members) {
      if (data.members[userId].hello === 'world') {
        try {
          await flockB.set(`flockInfo/members/${userId}`, { name: 'hacker' })
          await flockB.set(`flockInfo/members/${userId}`, { hello: 'hacked you' }, { encryptionKey: flockB.keyPair.secretKey })
          const result = await flockB.get(`flockInfo/members/${userId}`) // error when closing down
          if (!okPassed) t.ok(result.name !== 'hacker' && result.hello === 'world', 'should be unchanged')
          okPassed = true
        } catch { noop() }
        if (!passed) t.pass()
        passed = true
      }
    }
  })
})

async function create (t) {
  const dir = await tmp(t)
  const a = new FlockManager(dir)
  await a.ready()
  t.teardown(async () => await a.cleanup())
  return a
}

function noop () {}
