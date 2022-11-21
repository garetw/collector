import * as sysinfo from 'systeminformation'
///////////////////////// TOP INFLUXDB LIBRARY /////////////////////////
import { HttpError, InfluxDB, Point } from '@influxdata/influxdb-client'

import {
  AuthorizationsAPI,
  PingAPI,
  SetupAPI,
  OrgsAPI,
  SigninAPI,
  SignoutAPI,
} from '@influxdata/influxdb-client-apis'

// environment variables will override if not provided
const USERNAME = process.env.INFLUXDB_USERNAME || 'development'
const PASSWORD = process.env.INFLUXDB_PASSWORD || 'development'
const ORG = process.env.INFLUXDB_ORG || 'development'
const BUCKET = process.env.INFLUXDB_BUCKET || 'development'
//const RETENTION = process.env.INFLUXDB_RETENTION
const URL = process.env.INFLUXDB_URL || 'http://localhost:8086'
const TIMEOUT = 10 * 1000
const DEFAULT_TAGS = {
  hostname: 'localhost',
  app: 'telemetry',
}

// helpers
const log = console.log

// hoist
let client
let session
let writeApi

// functions
const connect = async (cxn) => {
  try {
    client = new InfluxDB(cxn)
    let ping = new PingAPI(client)
    await ping.getPing({ timeout: TIMEOUT })
    return client
  } catch (error) {
    log(error.toString())
  }
}

// initialize an influxdb database
// bail if it already exists
const init = async (config) => {
  try {
    let setup = new SetupAPI(client)
    const { semaphore } = await setup.getSetup({ timeout: TIMEOUT })
    if (semaphore) {
      setup
        .postSetup({ body: config })
        .then((r) => {
          log('InfluxDB setup completed')
          return true
        })
        .catch((e) => {
          log(e.toString())
        })
    } else {
      log('InfluxDB already setup')
      return true
    }
  } catch (error) {
    log(error.toString())
  }
}

// auth helper function to sign in and set session cookies
const signin = async (username = USERNAME, password = PASSWORD) => {
  try {
    const signinApi = new SigninAPI(client)
    const cookies = []
    await signinApi.postSignin(
      { auth: { user: username, password } },
      {
        responseStarted: (headers, status) => {
          if (status < 300) {
            const setCookie = headers['set-cookie']
            if (typeof setCookie === 'string') {
              cookies.push(setCookie.split(';').shift())
            } else if (Array.isArray(setCookie)) {
              setCookie.forEach((c) => cookies.push(c.split(';').shift()))
            }
          }
        },
      }
    )
    // authorize communication with session cookies
    // set global session (facilitates logout later)
    session = { headers: { cookie: cookies.join('; ') } }
    return session
  } catch (error) {
    if (error instanceof HttpError) {
      log(error.message)
    }
    log(error.toString())
  }
}

// auth function to sign in using a username and password
// and retrieve a token from the auth api endpoint
// checks for existing token and deletes it, then creates a new one
// checks organization, and applies authorization to the organization/bucket
const auth = async (username = USERNAME, password = PASSWORD, org = ORG) => {
  try {
    let tokenname = 'telemetry-api'

    await signin(username, password)

    const authorizationAPI = new AuthorizationsAPI(client)
    const authorizations = await authorizationAPI.getAuthorizations({}, session)

    let tokenID = undefined

    ;(authorizations.authorizations || []).forEach((auth) => {
      if (auth.description === tokenname) {
        tokenID = auth.id
      }
    })

    // check organization, and assign to orgID
    const orgsResponse = await new OrgsAPI(client).getOrgs({ org }, session)
    if (!orgsResponse.orgs || orgsResponse.orgs.length === 0) {
      throw new Error(`No organization named ${org} found!`)
    }
    const orgID = orgsResponse.orgs[0].id

    // check if token exists, and delete if it does
    // this avoids duplication of tokens in influxdb
    if (tokenID) {
      await authorizationAPI.deleteAuthorizationsID(
        { authID: tokenID },
        session
      )
    }

    // create authorization
    const authn = await authorizationAPI.postAuthorizations(
      {
        body: {
          description: tokenname,
          orgID,
          permissions: [
            {
              action: 'read',
              resource: { type: 'buckets', orgID },
            },
            {
              action: 'write',
              resource: { type: 'buckets', orgID },
            },
          ],
        },
      },
      session
    )

    return authn.token
  } catch (error) {
    if (error instanceof HttpError) {
      log(error.message)
    } else {
      log(error)
    }
  }
}

// create a point to write to influxdb
// takes a measurement, fields: {}, tags: {}, and a timestamp
const point = (measurement, fields, tags, timestamp) => {
  var p = new Point(measurement, fields, tags)
  Object.entries(fields).forEach(([key, value]) => {
    p.floatField(key, value)
  })
  Object.entries({ ...DEFAULT_TAGS, ...tags }).forEach(([key, value]) => {
    p.tag(key, value)
  })
  p.timestamp(timestamp)
  return p
}

// handles writeapi actions for clean writes and
// cleaning out of buffer/queue on exit
// the writeapi requires initialization with a bucket and org
const write = {
  init: async (org, bucket) => {
    try {
      writeApi = client.getWriteApi(org, bucket)
      writeApi.useDefaultTags(DEFAULT_TAGS)
      writeApi = writeApi
    } catch (error) {
      log(error.toString())
    }
  },
  point: async (p) => {
    try {
      return writeApi.writePoint(p)
    } catch (error) {
      log(error.toString())
    }
  },
  points: async (ps) => {
    try {
      writeApi.writePoints(ps)
    } catch (error) {
      log(error.toString())
    }
  },
  close: async () => {
    try {
      return writeApi
        .close()
        .then(() => {
          return true
        })
        .catch((e) => {
          log(e)
          log(e.stack)
        })
    } catch (error) {
      log(error.toString())
    }
  },
}

// query function
const query = async (q) => {}

// potentially-useful transformations
const transform = () => {
  return {
    // given an object, return an array of objects
    // where each object is sorted by value, string || number
    splitObjByStringOrFloat: (obj) => {
      const str = {}
      const num = {}
      Object.entries(obj).forEach(([key, value]) => {
        if (typeof value === 'string') {
          str[key] = value
        } else if (typeof value === 'number' || typeof value === 'float') {
          num[key] = value
        }
      })
      return [num, str]
    },
  }
}

const logout = async () => {
  try {
    const signoutApi = new SignoutAPI(client)
    await signoutApi.postSignout({}, session)
    return true
  } catch (error) {
    log(error.toString())
  }
}
///////////////////////// END INFLUXDB LIBRARY /////////////////////////

///////////////////////// TOP SYSINFO MODULE /////////////////////////

// import * as sysinfo from 'systeminformation'
////////////////////////////////////////

// system information report
// takes an array of modules to report on
// i.e. ['uuid', 'currentLoad', 'mem', 'graphics', 'networkInterfaces'
// check systeminformation docs for more info

function info(modules) {
  try {
    return Promise.all(
      modules.map(async (m) => {
        return { [m]: await sysinfo[m]() }
      })
    )
  } catch (error) {
    log(error.toString())
  }
}

///////////////////////// END SYSINFO MODULE /////////////////////////

///////////////////////// TELEMETRY COLLECTOR /////////////////////////

// helper functions
const flatten = (arr) => {
  return arr.reduce((acc, cur) => {
    return { ...acc, ...cur }
  }, {})
}

// pick the stats we want,and format the data
// into fields and tags for influxdb
// hard-configuration for now around "NVIDIA" cards,
// but this filter could be removed, or extended
const format = (stats) => {
  try {
    let s = {
      cpuLoadAvg: stats.currentLoad.avgLoad,
      cpuLoadCurrent: stats.currentLoad.currentLoad,
      memActive: stats.mem.active / 1000000,
      memFree: stats.mem.free / 1000000,
      memTotal: stats.mem.total / 1000000,
      memUsed: stats.mem.used / 1000000,
      fsSize: stats.fsSize.map((f) => {
        return {
          fsName: f.fs,
          usePercent: f.use,
        }
      }),
      graphics: stats.graphics.controllers
        .filter((g) => {
          return g.vendor.includes('NVIDIA')
        })
        .map((g) => {
          return {
            model: g.model,
            vram: g.vram,
            fanspeed: g.fanSpeed,
            utilizationMemory: g.utilizationMemory,
            memoryUsed: g.memoryUsed,
            memoryFree: g.memoryFree,
            powerDraw: g.powerDraw,
            powerLimit: g.powerLimit,
            temperatureGpu: g.temperatureGpu,
          }
        }),
    }

    let graphics = s.graphics.map((i) => transform().splitObjByStringOrFloat(i))
    delete s.graphics
    let fsSize = s.fsSize.map((i) => transform().splitObjByStringOrFloat(i))
    delete s.fsSize
    let system = transform().splitObjByStringOrFloat(s)

    return { system, graphics, fsSize }
  } catch (error) {
    console.log(error.toString())
  }
}

const main = async () => {
  try {
    // set the poll interval
    // set the modules to report on
    const INTERVAL = process.env['TELEMETRY_INTERVAL'] || 3000
    const MONITOR = ['uuid', 'currentLoad', 'mem', 'graphics', 'fsSize']

    // connect, initialize, and authnz
    await connect({ url: URL })
    await init()
    let token = await auth()
    // reconnect with token
    await connect({ url: URL, token: token })

    // init the write api with the org and bucket
    await write.init(ORG, BUCKET)

    // collect stats every (n:INTERVAL) seconds
    setInterval(async () => {
      const TIME = new Date()
      const STATS = await info(MONITOR)
      let { system, graphics, fsSize } = format(flatten(STATS))
      // construct the points
      let systempoint = point('system', ...system, TIME)
      let graphicspoints = graphics.map((g) => point('graphics', ...g, TIME))
      let fsSizepoints = fsSize.map((f) => point('fs', ...f, TIME))
      // write points to influxdb using write.points
      write.points([systempoint, ...graphicspoints, ...fsSizepoints])

      // experimental:
      // create 6 new points, one for every joint in the robot arm and randomize, then write their angles to influxdb
      // let joint1 = point('joint_1', { angle: Math.random() * 360 }, {}, TIME)
      // let joint2 = point('joint_2', { angle: Math.random() * 360 }, {}, TIME)
      // let joint3 = point('joint_3', { angle: Math.random() * 360 }, {}, TIME)
      // let joint4 = point('joint_4', { angle: Math.random() * 360 }, {}, TIME)
      // let joint5 = point('joint_5', { angle: Math.random() * 360 }, {}, TIME)
      // let joint6 = point('joint_6', { angle: Math.random() * 360 }, {}, TIME)
      // write.points([joint1, joint2, joint3, joint4, joint5, joint6])
    }, INTERVAL)
  } catch (error) {
    log(error.toString())
  } finally {
    // it's not working but the thought is nice
    process.on('SIGTERM', async () => {
      try {
        await write.close()
        console.log('closed writeapi')
        await logout()
        console.log('logged out')
        process.exit(0)
      } catch (error) {
        console.log(error.toString())
      }
    })
  }
}

await main()

export { connect, init, auth, point, query, write, logout, info, transform }
