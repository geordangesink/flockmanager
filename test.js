const test = require('brittle')
const FlockManager = require('./')
const testnet = require('hyperdht/testnet')
const tmp = require('test-tmp')

test('basic', async function (t) {
  const a = await create(t)

  const flock = await a.initFlock()
  await flock.autobee.put('hello', 'world')

  t.ok(flock.autobee.encryptionKey)
  t.is(await flock.autobee.get('hello'), 'world')

  await a.cleanup()
})

test('invites', async function (t) {
  t.plan(2)

  const tn = await testnet(10, t)

  const a = await create(t, { bootstrap: tn.bootstrap })
  const flockA = await a.initFlock()
  t.teardown(() => {
    a.cleanup()
  })

  const onUpdate = function () {
    if (flockA.autobee.system.members === 2) t.pass('a has two members')
  }

  flockA.autobee.once('update', onUpdate)

  const inv = flockA.invite

  const b = await create(t, { bootstrap: tn.bootstrap })
  const flockB = await b.initFlock(inv)

  t.teardown(() => b.close())
  flockB.autobee.once('update', function () {
    if (flockB.autobee.system.members === 2) t.pass('b has two members')
  })
})

async function create (t) {
  const dir = await tmp(t)
  const a = new FlockManager(dir)
  await a.ready()
  return a
}
