#!/usr/bin/env python3
import json, pathlib, shutil, subprocess, sys, tempfile

BASE="fed39bbe7170dc381862f5809b24954384daf293"
UPSTREAM="https://github.com/lami216/offline-conta.git"
THEIRS="refs/remotes/upstream/main"
ROOT=pathlib.Path.cwd()

def run(*args, check=True, text=True):
    p=subprocess.run(args,cwd=ROOT,text=text,capture_output=True)
    if check and p.returncode:
        print(p.stdout)
        print(p.stderr,file=sys.stderr)
        raise SystemExit(p.returncode)
    return p

def show(ref,path):
    p=run("git","show",f"{ref}:{path}",check=False,text=False)
    return None if p.returncode else p.stdout

def files(ref):
    return set(run("git","ls-tree","-r","--name-only",ref).stdout.splitlines())

def write(path,data):
    target=ROOT/path
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_bytes(data)

def remove(path):
    target=ROOT/path
    if target.exists() or target.is_symlink():
        if target.is_dir() and not target.is_symlink(): shutil.rmtree(target)
        else: target.unlink()

run("git","remote","remove","upstream",check=False)
run("git","remote","add","upstream",UPSTREAM)
run("git","fetch","--no-tags","upstream","main")
base_files=files(BASE); theirs_files=files(THEIRS)
conflicts=[]

SKIP={"app/api/command/route.ts","package-lock.json","desktop/main.cjs","package.json",".github/workflows/build-windows-desktop.yml"}

for path in sorted(base_files|theirs_files):
    if path in SKIP: continue
    b=show(BASE,path); t=show(THEIRS,path)
    target=ROOT/path
    o=target.read_bytes() if target.exists() and target.is_file() else None
    if b==t: continue
    if o==b:
        if t is None: remove(path)
        else: write(path,t)
        continue
    if t is None:
        print(f"[keep ours: upstream deleted but perfume changed] {path}")
        continue
    if b is None:
        if o is None: write(path,t)
        elif o!=t:
            conflicts.append(path); print(f"[conflict: both added] {path}")
        continue
    if o is None:
        conflicts.append(path); print(f"[conflict: perfume deleted, upstream changed] {path}")
        continue
    if o==t: continue
    with tempfile.TemporaryDirectory() as tdname:
        td=pathlib.Path(tdname)
        (td/"ours").write_bytes(o); (td/"base").write_bytes(b); (td/"theirs").write_bytes(t)
        p=subprocess.run(["git","merge-file","-p",str(td/"ours"),str(td/"base"),str(td/"theirs")],cwd=ROOT,capture_output=True)
        if p.returncode == 255:
            conflicts.append(path); print(f"[conflict: merge error] {path}"); continue
        write(path,p.stdout)
        if p.returncode:
            conflicts.append(path); print(f"[conflict] {path} ({p.returncode} hunks)")

b=show(BASE,"app/api/command/route.ts")
t=show(THEIRS,"app/api/command/route.ts")
target=ROOT/"app/api/command/base-route.ts"
o=target.read_bytes()
with tempfile.TemporaryDirectory() as tdname:
    td=pathlib.Path(tdname)
    (td/"ours").write_bytes(o); (td/"base").write_bytes(b); (td/"theirs").write_bytes(t)
    p=subprocess.run(["git","merge-file","-p",str(td/"ours"),str(td/"base"),str(td/"theirs")],cwd=ROOT,capture_output=True)
    write("app/api/command/base-route.ts",p.stdout)
    if p.returncode:
        conflicts.append("app/api/command/base-route.ts"); print(f"[conflict] app/api/command/base-route.ts ({p.returncode} hunks)")

main=show(THEIRS,"desktop/main.cjs").decode()
main=main.replace("const PRODUCT_NAME='الكرنه';","const PRODUCT_NAME='الكرنة للعطور';\\nconst APP_ID='mr.alkarna.perfume.desktop';\\nconst USER_DATA_DIR='AlKarna-Perfume';")
anchor="const {spawn}=require('node:child_process');const {join}=require('node:path');const {mkdirSync,createWriteStream}=require('node:fs');"
if anchor in main:
    main=main.replace(anchor,anchor+"\\nconst isolatedUserData=join(app.getPath('appData'),USER_DATA_DIR);mkdirSync(isolatedUserData,{recursive:true});app.setPath('userData',isolatedUserData);",1)
main=main.replace("ALKARNA_DATABASE_PATH:join(userData,'data','alkarna.sqlite')","ALKARNA_DATABASE_PATH:join(userData,'data','alkarna-perfume.sqlite'),ALKARNA_LICENSE_STATE_PATH:join(process.env.LOCALAPPDATA||userData,'PayZone','AlKarna-Perfume-Licensing','state-v2.json'),ALKARNA_LICENSE_DISABLE_REGISTRY:'1'")
main=main.replace("app.setAppUserModelId('mr.alkarna.desktop')","app.setAppUserModelId(APP_ID)")
main=main.replace('app.setAppUserModelId("mr.alkarna.desktop")',"app.setAppUserModelId(APP_ID)")
main=main.replace("app.setAppUserModelId(PRODUCT_NAME)","app.setAppUserModelId(APP_ID)")
main=main.replace("تعذر تشغيل الكرنه.", "تعذر تشغيل "+chr(36)+"{PRODUCT_NAME}.")
main=main.replace("توقف خادم الكرنه بشكل غير متوقع.", "توقف خادم "+chr(36)+"{PRODUCT_NAME} بشكل غير متوقع.")
write("desktop/main.cjs",main.encode())

pkg=json.loads(show(THEIRS,"package.json"))
pkg["name"]="alkarna-perfume-desktop"
pkg["displayName"]="الكرنة للعطور"
build=pkg.setdefault("build",{})
build["appId"]="mr.alkarna.perfume.desktop"
build["productName"]="الكرنة للعطور"
build.setdefault("win",{})["executableName"]="AlKarna-Perfume"
nsis=build.setdefault("nsis",{})
nsis["shortcutName"]="الكرنة للعطور"
nsis["artifactName"]="AlKarna-Perfume-Setup-x64.exe"
write("package.json",(json.dumps(pkg,ensure_ascii=False,indent=2)+"\\n").encode())

workflow=show(THEIRS,".github/workflows/build-windows-desktop.yml").decode()
workflow=workflow.replace("AlKarna-Setup-x64.exe","AlKarna-Perfume-Setup-x64.exe")
workflow=workflow.replace("AlKarna-Windows-x64-","AlKarna-Perfume-Windows-x64-")
write(".github/workflows/build-windows-desktop.yml",workflow.encode())

if conflicts:
    pathlib.Path(".sync-conflicts.txt").write_text("\\n".join(sorted(set(conflicts)))+"\\n")
    print(f"MERGE_CONFLICTS={len(set(conflicts))}")
    sys.exit(2)

run("npm","install","--package-lock-only","--ignore-scripts")
run("git","diff","--check")
print("SYNC_MERGE_OK")
