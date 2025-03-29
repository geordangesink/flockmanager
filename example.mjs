import FlockManager from './index.js'
import fs from 'fs'

// clean start
const dir = 'example/' + process.argv[2]
if (fs.existsSync(dir)) {
  fs.rmSync(dir, { recursive: true, force: true })
}

const flockManager = new FlockManager(dir)
await flockManager.ready()
process.on('beforeExit', () => flockManager.cleanup())

await flockManager.setUserData({ name: 'Steve' })

const flock = await flockManager.initFlock(process.argv[3])
console.log('invite', flock.invite)

flock.on('update', onupdate)

await flockManager.setUserData({ name: 'Jack Black' })

await flockManager.set('Steve', 'JackBlack')
await flock.set('BlackJack', 'Steve')

const steve = await flockManager.get('Steve')
const blackJack = await flock.get('BlackJack')
console.log(steve, blackJack)

async function onupdate () {
  console.log('db chanded, flock info:')
  const data = await flock.getByPrefix('flockInfo/')
  console.log(data)
  if (flock.autobee.system.members === 2 && Object.values(data.members).map(userData => userData.name === 'Jack Black' && 1).length === 2) {
    setTimeout(() => {
      console.log('Work done. Exiting...')
      process.exit(0)
    }, 5000)
  }
}
