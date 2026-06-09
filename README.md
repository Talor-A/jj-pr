# jj-tools

tools for stacking and rebasing PRs with github using [jujutsu vcs](https://github.com/jj-vcs/jj).

## Description



## Install

requirements:

- `jj`
- `gh`

first, install via your package manager of choice:

```sh
bun i -g jj-tools
pnpm i -g jj-tools
npm i -g jj-tools
yarn global add jj-tools
```

next, configure as an alias in `.config/jj/config.toml`:

```toml

[aliases]
# ....
# 
pr = ["util", "exec", "--", 'jjtools', 'pr "$@"', ""]
# or exec bun run jjtools to use bun instead of node.
```


## Usage

```sh
jj pr --help
```

basic usage:
```sh
# create a PR at the nearest pushable change.
# ignores changes that can't be pushed (eg missing descriptions)
jj pr
```

you can also specify a `<revset>` to create PRs for a specific range of changes:

```sh
# create a PR at the nearest pushable change to <revset>.
jj pr <revset>
```

this will:
1. look for the nearest pushable change to `<revset>`.
2. create a bookmark at that change if one doesn't already exist.
3. for the newly created bookmark, and for each bookmark above and below `<revset>`, create a PR if one doesn't already exist.
4. point each PR at the previous PR in the stack.
5. Update each PR's description with links to each PR in the stack.

before pushing any new branches or opening any PRs, `jj pr` will pause for confirmation. If you want to see what changes `jj pr` would make without actually pushing anything, use `--dry-run`:

```sh
jj pr --dry-run <revset>
```

You can create multiple PRs at a time if `<revset>` is a range of changes. `jj pr` will create a PR for each bookmark in the range.

For example, the below command will create a new PR for each change between the repo's base branch and the current change.

```sh
jj pr 'trunk()..@' # create a PR for every change between the repo's base branch and the current change
```

`jj pr` also automatically detects all bookmarks in your existing stack, and will automatically update them. You can use this to add new PRs in between existing ones.

for example, given a log like this:

```sh
jj log

@  lxnsotyp public-github@taloranderson.com 2026-06-08 18:24:51 default@ 9f5f5e48
│  (empty) (no description set)
◇  rqmkxwvo public-github@taloranderson.com 2026-06-08 18:24:42 ta/jj/add-streaming-test eeb7e010
│  add streaming test
◇  uvxnkynk public-github@taloranderson.com 2026-06-08 13:41:35 dbb151e9
│  convert runBash to streamBash
◇  klrvwsvr public-github@taloranderson.com 2026-06-08 13:40:10 59c4fda6
│  refactor bash utils
~
```
there's an existing bookmark at `rq`. If we want to introduce a new PR, say for `kl` where we do some refactoring that we want in a separate PR, `jj pr kl` will insert a new bookmark at `kl`, create a PR pointing to `trunk()`, and point the existing bookmark at `rq` to the new PR.


## Why jj-tools?

`jj pr` is a helper that I've slowly built and refined to be the best way to manage PRs with github using `jj`. It is flexible and does not impose any specific workflow. In particular:
- PRs can be made up of one or more commits. some tools want a strictly patch-based workflow where one commit always corresponds to one PR. `jj pr` allows you to create PRs for one or more commits.
- PRs will have bookmarks automatically generated if they don't exist. If you want to name your bookmarks in a certain way, you can create them first before running `jj pr`, and they will be reused automatically.
