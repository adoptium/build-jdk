import * as exec from '@actions/exec'
import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'
import * as io from '@actions/io'
import * as path from 'path'
import * as fs from 'fs'
import * as childProcess from 'child_process'
import {ExecOptions} from '@actions/exec/lib/interfaces'

let tempDirectory = process.env['RUNNER_TEMP'] || ''
const workDir = process.env['GITHUB_WORKSPACE']
//const dependenciesDir =  `${workDir}/tmp`
const buildDir = `${workDir}/temurin-build`
const IS_WINDOWS = process.platform === 'win32'
const targetOs = IS_WINDOWS ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'

if (!tempDirectory) {
  let baseLocation

  if (IS_WINDOWS) {
    // On windows use the USERPROFILE env variable
    baseLocation = process.env['USERPROFILE'] || 'C:\\'
  } else if (process.platform === 'darwin') {
    baseLocation = '/Users'
  } else {
    baseLocation = '/home'
  }
  tempDirectory = path.join(baseLocation, 'actions', 'temp')
}

export async function buildJDK(
  javaToBuild: string,
  impl: string,
  usePRRef: boolean
): Promise<void> {
  //set parameters and environment
  const time = new Date().toISOString().split('T')[0]
  await io.mkdirP('jdk')
  process.chdir('jdk')
  await io.mkdirP('boot')
  await io.mkdirP('home')
  process.chdir(`${workDir}`)

  //pre-install dependencies
  await installDependencies(javaToBuild, impl)
  let jdkBootDir = ''
  const bootJDKVersion = getBootJdkVersion(javaToBuild)
  
  if (`JAVA_HOME_${bootJDKVersion}_X64` in process.env) {
    jdkBootDir = process.env[`JAVA_HOME_${bootJDKVersion}_X64`] as string
    if (IS_WINDOWS) {
      jdkBootDir = jdkBootDir.replace(/\s/g, '')
      jdkBootDir = jdkBootDir.replace(/\\/g, '/')
      jdkBootDir = jdkBootDir.replace(/ProgramFiles/g, 'Progra~1')
    }
  } else {
    jdkBootDir = await getBootJdk(bootJDKVersion, impl)
  }
  
  await getOpenjdkBuildResource(usePRRef)
  //got to build Dir
  process.chdir(`${buildDir}`)
  
  //build
  // workround of issue https://github.com/sophia-guo/build-jdk/issues/6
  core.exportVariable('ARCHITECTURE', 'x64')
  let configureArgs
  const fileName = `Open${javaToBuild.toUpperCase()}-jdk_x64_${targetOs}_${impl}_${time}`
  let fullFileName = `${fileName}.tar.gz`
  let skipFreetype = ""
  if (`${targetOs}` === 'mac') {
    configureArgs = "--disable-warnings-as-errors --with-extra-cxxflags='-stdlib=libc++ -mmacosx-version-min=10.8'"
  } else if (`${targetOs}` === 'linux') {
    skipFreetype = "--skip-freetype"

    if (`${impl}` === 'hotspot') {
      configureArgs = '--disable-ccache --disable-warnings-as-errors'
    } else {
      configureArgs = '--disable-ccache --enable-jitserver --disable-warnings-as-errors --with-openssl=/usr/local/openssl-1.0.2 --enable-cuda --with-cuda=/usr/local/cuda-9.0'
    }

    // If current JDK version is greater than (or equal to) 15, "auto" is no longer a valid value for the enable-dtrace config parameter.
    if ((parseInt(getBootJdkVersion(javaToBuild)) + 1) >= 15) {
      configureArgs = configureArgs + ' --enable-dtrace'
    } else {
      configureArgs = configureArgs + ' --enable-dtrace=auto'
    }
  } else {
    if (`${impl}` === 'hotspot') {
      configureArgs = "--disable-ccache --disable-warnings-as-errors"
    } else {
      configureArgs = "--with-freemarker-jar='c:/freemarker.jar' --with-openssl='c:/OpenSSL-1.1.1g-x86_64-VS2017' --enable-openssl-bundling --enable-cuda -with-cuda='C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v9.0'"
    }
    fullFileName = `${fileName}.zip`
  }

  await exec.exec(`bash ./makejdk-any-platform.sh \
  -J "${jdkBootDir}" \
  "${skipFreetype}" \
  --configure-args "${configureArgs}" \
  -d artifacts \
  --target-file-name ${fullFileName} \
  --use-jep319-certs \
  --build-variant ${impl} \
  --disable-adopt-branch-safety \
  ${javaToBuild}`)

  // TODO: update directory for ubuntu
  await printJavaVersion(javaToBuild)
  process.chdir(`${workDir}`)

  try {
    await exec.exec(`find ./ -name ${fullFileName}`)
  } catch (error) {
    core.setFailed(`build failed and ${error.message}`)
  }
}

async function getOpenjdkBuildResource(usePPRef: Boolean): Promise<void> {
  if (!usePPRef) {
    await exec.exec(`git clone --depth 1 https://github.com/adoptium/temurin-build.git`)
  }
}

async function installDependencies(javaToBuild: string, impl: string): Promise<void> {
  if (`${targetOs}` === 'mac') {
    await installMacDepends(javaToBuild, impl)
  } else if (`${targetOs}` === 'linux') {
    await installLinuxDepends(javaToBuild, impl)
  } else {
    await installWindowsDepends(javaToBuild, impl)
  }
  await installCommons()
}

async function installCommons(): Promise<void> {
  //TODO placeholder
}

async function installMacDepends(javaToBuild: string, impl: string): Promise<void> {
  //TODO using jdk default on github action virtual machine, gnu-tar will not be necessary
  await exec.exec('brew install autoconf ccache coreutils gnu-tar')
  core.addPath('/usr/local/opt/gnu-tar/libexec/gnubin')
  core.info(`path is ${process.env['PATH']}`)

  if (`${impl}` === 'openj9') {
    await exec.exec('brew install bash nasm')
  }
}

async function installWindowsDepends(javaToBuild: string, impl: string): Promise<void> {
  //install cgywin
  await io.mkdirP('C:\\cygwin64')
  await io.mkdirP('C:\\cygwin_packages')
  await tc.downloadTool('https://cygwin.com/setup-x86_64.exe', 'C:\\temp\\cygwin.exe')
  await exec.exec(`C:\\temp\\cygwin.exe  --packages wget,bsdtar,rsync,gnupg,git,autoconf,make,gcc-core,mingw64-x86_64-gcc-core,unzip,zip,cpio,curl,grep,perl --quiet-mode --download --local-install
  --delete-orphans --site  https://mirrors.kernel.org/sourceware/cygwin/
  --local-package-dir "C:\\cygwin_packages"
  --root "C:\\cygwin64"`)
  await exec.exec(`C:/cygwin64/bin/git config --system core.autocrlf false`)
  core.addPath(`C:\\cygwin64\\bin`)

  if (`${impl}` === 'openj9') {
    await tc.downloadTool(`https://repo.maven.apache.org/maven2/freemarker/freemarker/2.3.8/freemarker-2.3.8.jar`, 'c:\\freemarker.jar')
    //nasm
    await io.mkdirP('C:\\nasm')
    await tc.downloadTool(`https://www.nasm.us/pub/nasm/releasebuilds/2.13.03/win64/nasm-2.13.03-win64.zip`, 'C:\\temp\\nasm.zip')
    await tc.extractZip('C:\\temp\\nasm.zip', 'C:\\nasm')
    const nasmdir = path.join('C:\\nasm', fs.readdirSync('C:\\nasm')[0])
    core.addPath(nasmdir)
    await io.rmRF('C:\\temp\\nasm.zip')
    //llvm
    await tc.downloadTool('https://ci.adoptopenjdk.net/userContent/winansible/llvm-7.0.0-win64.zip', 'C:\\temp\\llvm.zip')
    await tc.extractZip('C:\\temp\\llvm.zip', 'C:\\')
    await io.rmRF('C:\\temp\\llvm.zip')
    core.addPath('C:\\Program Files\\LLVM\\bin')
    //cuda
    await tc.downloadTool('https://developer.nvidia.com/compute/cuda/9.0/Prod/network_installers/cuda_9.0.176_win10_network-exe', 'C:\\temp\\cuda_9.0.176_win10_network-exe.exe')
    await exec.exec(`C:\\temp\\cuda_9.0.176_win10_network-exe.exe -s compiler_9.0 nvml_dev_9.0`)
    await io.rmRF(`C:\\temp\\cuda_9.0.176_win10_network-exe.exe`)
    //openssl
    await tc.downloadTool('https://www.openssl.org/source/openssl-1.1.1g.tar.gz', 'C:\\temp\\OpenSSL-1.1.1g.tar.gz')
    await tc.extractTar('C:\\temp\\OpenSSL-1.1.1g.tar.gz', 'C:\\temp')
 
    process.chdir('C:\\Program Files (x86)\\Microsoft Visual Studio\\2017\\Enterprise\\VC\\Auxiliary\\Build')
    core.addPath('C:\\Strawberry\\perl\\bin')
    childProcess.execSync(`.\\vcvarsall.bat AMD64 && cd C:\\temp\\OpenSSL-1.1.1g && perl C:\\temp\\OpenSSL-1.1.1g\\Configure VC-WIN64A --prefix=C:\\OpenSSL-1.1.1g-x86_64-VS2017 && nmake.exe install > C:\\temp\\openssl64-VS2017.log && nmake.exe -f makefile clean`)
    await io.rmRF('C:\\temp\\OpenSSL-1.1.1g.tar.gz')
    await io.rmRF(`C:\\temp\\OpenSSL-1.1.1g`)
    process.chdir(`${workDir}`)
  }
}

async function installLinuxDepends(javaToBuild: string, impl: string): Promise<void> {
  const ubuntuVersion = await getOsVersion()
  if (`${ubuntuVersion}` === '16.04') {
    await exec.exec('sudo apt-get update')
    await exec.exec(
      'sudo apt-get install -qq -y --no-install-recommends \
      python-software-properties \
      realpath'
    )
  } 

  await exec.exec('sudo apt-get update')
  await exec.exec(
    'sudo apt-get install -qq -y --no-install-recommends \
    software-properties-common \
    autoconf \
    cpio \
    libasound2-dev \
    libcups2-dev \
    libelf-dev \
    libfontconfig1-dev \
    libfreetype6-dev \
    libx11-dev \
    libxext-dev \
    libxrender-dev \
    libxrandr-dev \
    libxt-dev \
    libxtst-dev \
    make \
    systemtap-sdt-dev \
    libnuma-dev \
    gcc-multilib \
    pkg-config'
  )

  if (javaToBuild === 'jdk8u') {
    await exec.exec('sudo add-apt-repository ppa:openjdk-r/ppa')
    await exec.exec(`sudo apt-get update`)
    await exec.exec('sudo apt-get install -qq -y --no-install-recommends openjdk-7-jdk')
  }

  if (`${impl}` === 'openj9') {
    await exec.exec('sudo apt-get update')
    await exec.exec(
      'sudo apt-get install -qq -y --no-install-recommends \
      nasm \
      libdwarf-dev \
      ssh'
    )

    //install cuda9
    const cuda9 = await tc.downloadTool('https://developer.nvidia.com/compute/cuda/9.0/Prod/local_installers/cuda_9.0.176_384.81_linux-run')
    await exec.exec(`sudo sh ${cuda9} --silent --toolkit --override`)
    await io.rmRF(`${cuda9}`)
   
    const opensslV = await tc.downloadTool('https://www.openssl.org/source/old/1.0.2/openssl-1.0.2r.tar.gz')
    await tc.extractTar(`${opensslV}`, `${tempDirectory}`)
    process.chdir(`${tempDirectory}/openssl-1.0.2r`)
    await exec.exec(`sudo ./config --prefix=/usr/local/openssl-1.0.2 shared`)
    await exec.exec(`sudo make`)
    await exec.exec(`sudo make install`)
    await io.rmRF(`${opensslV}`)
  }
  await io.rmRF(`/var/lib/apt/lists/*`)

  process.chdir('/usr/local')
  const gccBinary = await tc.downloadTool(`https://ci.adoptopenjdk.net/userContent/gcc/gcc730+ccache.x86_64.tar.xz`)
  await exec.exec(`ls -l ${gccBinary}`)
  await exec.exec(`sudo tar -xJ --strip-components=1 -C /usr/local -f ${gccBinary}`)
  await io.rmRF(`${gccBinary}`)

  await exec.exec(`sudo ln -s /usr/lib/x86_64-linux-gnu /usr/lib64`)
  await exec.exec(`sudo ln -s /usr/include/x86_64-linux-gnu/* /usr/local/include`)
  await exec.exec(`sudo ln -sf /usr/local/bin/g++-7.3 /usr/bin/g++`)
  await exec.exec(`sudo ln -sf /usr/local/bin/gcc-7.3 /usr/bin/gcc`)
  process.env.LIBRARY_PATH=`/usr/lib/x86_64-linux-gnu:${process.env.LIBRARY_PATH}`
  process.chdir(`${workDir}`)
}


//TODO: side effects of using pre-installed jdk on github action virtual machine
async function getBootJdk(bootJDKVersion: string, impl: string): Promise<string> {
    if (parseInt(bootJDKVersion) > 8) {
    let bootjdkJar
    // TODO: issue open openj9,mac, 10 ga : https://api.adoptopenjdk.net/v3/binary/latest/10/ga/mac/x64/jdk/openj9/normal/adoptopenjdk doesn't work
    if (
      `${impl}` === 'openj9' &&
      `${bootJDKVersion}` === '10' &&
      `${targetOs}` === 'mac'
    ) {
      bootjdkJar = await tc.downloadTool(`https://github.com/AdoptOpenJDK/openjdk10-binaries/releases/download/jdk-10.0.2%2B13.1/OpenJDK10U-jdk_x64_mac_hotspot_10.0.2_13.tar.gz`)
    } else {
      bootjdkJar = await tc.downloadTool(`https://api.adoptopenjdk.net/v3/binary/latest/${bootJDKVersion}/ga/${targetOs}/x64/jdk/${impl}/normal/adoptopenjdk`)
    }

    if (`${targetOs}` === 'mac') {
      await exec.exec(`sudo tar -xzf ${bootjdkJar} -C ./jdk/boot --strip=3`)
    } else if (`${targetOs}` === 'linux') {
      if (`${bootJDKVersion}` === '10' && `${impl}` === 'openj9') {
        await exec.exec(`sudo tar -xzf ${bootjdkJar} -C ./jdk/boot --strip=2`) // TODO : issue open as this is packaged differently
      } else {
        await exec.exec(`sudo tar -xzf ${bootjdkJar} -C ./jdk/boot --strip=1`)
      }
    } else {
      // windows jdk is zip file
      const tempDir = path.join(tempDirectory, 'temp_' + Math.floor(Math.random() * 2000000000))
      await tc.extractZip(bootjdkJar, `${tempDir}`)
      const tempJDKDir = path.join(tempDir, fs.readdirSync(tempDir)[0])
      process.chdir('c:\\')
      await io.mkdirP('jdkboot')
      await exec.exec(`mv ${tempJDKDir}/* c:\\jdkboot`)
      process.chdir(`${workDir}`)
    }
    await io.rmRF(`${bootjdkJar}`)
  } else {
    //TODO : need to update for jdk8
    const jdk8Jar = await tc.downloadTool('https://api.adoptopenjdk.net/v2/binary/releases/openjdk8?os=mac&release=latest&arch=x64&heap_size=normal&type=jdk&openjdk_impl=hotspot')
    await exec.exec(`sudo tar -xzf ${jdk8Jar} -C ./jdk/home --strip=3`)
    await io.rmRF(`${jdk8Jar}`)
  }

  if (IS_WINDOWS) {
    return 'c:/jdkboot'
  } else {
    return `${workDir}/jdk/boot`
  } 
}

function getBootJdkVersion(javaToBuild: string): string {
  let bootJDKVersion

  //latest jdk need update continually
  if (`${javaToBuild}` === 'jdk') {
    bootJDKVersion = '16'
  } else {
    bootJDKVersion = javaToBuild.replace('jdk', '')
    if (bootJDKVersion.includes('u')) {
      bootJDKVersion = bootJDKVersion.substr(0, bootJDKVersion.length - 1)
    }
    bootJDKVersion = (parseInt(bootJDKVersion) - 1).toString()
  }
  return bootJDKVersion
}

async function printJavaVersion(javaToBuild: string): Promise<void> {
  let platform
  if (`${targetOs}` === 'linux') {
    platform = 'linux'
  } else if (`${targetOs}` === 'mac') {
    platform = 'macosx'
  } else {
    platform = 'windows'
  }
  let platformRelease = `${platform}-x86_64-normal-server-release`

  if (`${javaToBuild}` === 'jdk') {
    platformRelease = `${platform}-x86_64-server-release`
  } else {
    let version = javaToBuild.replace('jdk', '')
    version = version.substr(0, version.length - 1)
    if (parseInt(version) >= 13) platformRelease = `${platform}-x86_64-server-release` 
  }
  process.chdir(`${buildDir}`)
  const jdkdir = `workspace/build/src/build/${platformRelease}/jdk`
  process.chdir(`${jdkdir}/bin`)
  await exec.exec(`./java -version`)
/*   if (javaToBuild === 'jdk8u') {
    jdkImages = `workspace/build/src/build/${platformRelease}/images/j2sdk-image`
    process.chdir(`${jdkImages}/jre/bin`)
  } else {
    jdkImages = `workspace/build/src/build/${platformRelease}/images/jdk`
    process.chdir(`${jdkImages}/bin`)
  } */
  //set outputs
  core.setOutput('BuildJDKDir', `${buildDir}/${jdkdir}`)
}

async function getOsVersion(): Promise<string> {
  let osVersion = ''
  const options: ExecOptions = {}
  let myOutput = ''
  options.listeners = {
    stdout: (data: Buffer) => {
      myOutput += data.toString()
    }
  }

  if (IS_WINDOWS) {
    //TODO
  } else if (`${targetOs}` === 'mac') {
    //TODO
  } else {
    exec.exec(`lsb_release`, ['-r', '-s'], options)
    if (myOutput.includes('16.04')) {
      osVersion = '16.04'
    } else {
      osVersion = '18.04'
    }
  }
  return osVersion
}