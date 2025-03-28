const test = require('brittle')
const FlockManager = require('./')
const testnet = require('hyperdht/testnet')
const tmp = require('test-tmp')

test('basic', async function (t) {
  const a = await create(t)
  t.teardown(() => a.cleanup())

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

  flockA.on('update', async function onUpdate () {
    if (flockA.autobee.system.members === 2) {
      flockA.off('update', onUpdate) // bit hacky because other updates come before
      t.pass('a has two members')
    }
  })

  const inv = flockA.invite

  const b = await create(t, { bootstrap: tn.bootstrap })
  const flockB = await b.initFlock(inv)

  flockB.on('update', async function onUpdate () {
    if (flockB.autobee.system.members === 2) {
      flockB.off('update', onUpdate) // bit hacky because other updates come before
      t.pass('b has two members')
    }
  })

  t.teardown(async () => {
    setTimeout(async () => {
      console.log('workaround for now to avoid session closed hypercore error')
      a.cleanup()
      b.cleanup()
    }, 4000)
  })
})

test('userData updates', async function (t) {
  t.plan(1)
  const tn = await testnet(12, t)

  const a = await create(t, { bootstrap: tn.bootstrap })
  const flockA = await a.initFlock()

  const inv = flockA.invite

  const b = await create(t, { bootstrap: tn.bootstrap })
  const flockB = await b.initFlock(inv)

  await a.setUserData({ hello: 'world' })

  flockB.on('update', async function onUpdate () {
    const data = await flockB.getByPrefix('flockInfo/')
    if (Object.values(data.members).some(userData => userData.hello === 'world')) {
      flockB.off('update', onUpdate) // Remove the listener
      t.pass('b received updated userData')
    }
  })
  t.teardown(async () => {
    setTimeout(async () => {
      console.log('workaround for now to avoid session closed hypercore error')
      a.cleanup()
      b.cleanup()
    }, 4000)
  })
})

// TODO: encryption test
test('userData encryption', async function (t) {
  t.plan(2)
  const tn = await testnet(12, t)

  const a = await create(t, { bootstrap: tn.bootstrap })
  const flockA = await a.initFlock()

  const inv = flockA.invite

  const b = await create(t, { bootstrap: tn.bootstrap })
  const flockB = await b.initFlock(inv)

  await a.setUserData({ hello: 'world' })

  flockB.on('update', async function onUpdate () {
    const data = await flockB.getByPrefix('flockInfo/')
    for (const userId in data.members) {
      if (data.members[userId].hello === 'world') {
        flockB.off('update', onUpdate)
        try {
          await flockB.set(`flockInfo/members/${userId}`, { name: 'hacker' })
          await flockB.set(`flockInfo/members/${userId}`, { hello: 'hacked you' }, { encryptionKey: flockB.keyPair.secretKey })
        } catch { noop() }
        const result = await flockB.get(`flockInfo/members/${userId}`)
        console.log(result)
        t.pass()
        t.ok(result.name !== 'hacker' && result.hello === 'world', 'should be unchanged')
      }
    }
  })
  t.teardown(async () => {
    setTimeout(async () => {
      console.log('workaround for now to avoid session closed hypercore error')
      a.cleanup()
      b.cleanup()
    }, 4000)
  })
})

async function create (t) {
  const dir = await tmp(t)
  const a = new FlockManager(dir)
  await a.ready()
  return a
}

function noop () {}
