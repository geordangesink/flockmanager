import FlockManager from './index.js'

const flockManager = new FlockManager('example/' + process.argv[2])
await flockManager.ready()
process.on('beforeExit', () => flockManager.cleanup())

await flockManager.setUserData({ name: 'Steve' })

const flock = await flockManager.initFlock(process.argv[3])
console.log('invite', flock.invite)

flock.autobee.on('update', onupdate)

await flockManager.setUserData({ name: 'Jack Black' })

await flockManager.set('Steve', 'JackBlack')
await flock.set('BlackJack', 'Steve')

const steve = await flockManager.get('Steve')
const blackJack = await flock.get('BlackJack')
console.log(steve, blackJack)

async function onupdate () {
  console.log('db chanded, flock info:')
  const data = await flock.autobee.get('flockInfo')
  console.log(data)
  if (flock.autobee.system.members === 2 && Object.values(data.members).map(userData => userData.name === 'Jack Black' && 1).length === 2) {
    setTimeout(() => {
      console.log('Work done. Exiting...')
      process.exit(0)
    }, 5000)
  }
}
