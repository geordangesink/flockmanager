import FlockManager from './index.js'

const flockManager = new FlockManager('example/' + process.argv[2])
await flockManager.ready()

console.log(process.argv[2])
console.log(process.argv[3])

await flockManager.setUserData({ myBirthday: new Date() })

const flock = await flockManager.initFlock(process.argv[3])
console.log('invite', flock.invite)
flock.autobee.on('update', onupdate)

async function onupdate () {
  console.log('db chanded, flock info:')
  const info = await flock.autobee.get('flockInfo')
  console.log(info)
}
