# jj-pr

tools for stacking and rebasing PRs with github using [jujutsu vcs](https://github.com/jj-vcs/jj).

## Description

`jj pr` is a helper that I've slowly built and refined to be the best way to manage Pull Requests with GitHub using `jj` (jujutsu) vcs.  

PR stacking with plain git is a difficult and error-prone process. `jj` itself alleviates many of these issues. It provides seamless tools to split, reorder, rebase, and combine changes. `jj pr` adds a layer on top of `jj` to make PR management easier. 

Given a stack of commits, `jj pr` supports:
- turning one or more commits into a PR
- automatically pointing PRs to previous PRs in stack
- inserting PRs anywhere at the top, bottom, or middle of the stack
 
Some notes on the implementation:
- PRs can be made up of one or more commits. some tools want a strictly patch-based workflow where one commit always corresponds to one PR. `jj pr` allows you to create PRs for one or more commits.
- PRs will have bookmarks automatically generated if they don't exist. If you want to name your bookmarks in a certain way, you can create them first before running `jj pr`, and they will be reused automatically.

## Install

requirements:

- `jj` (`jj-pr` is tested to be compatible with `jj` versions `0.41.0` and `0.42.0`. Other versions may not work.)
- `gh`

first, install via your package manager of choice:

```sh
bun i -g jj-pr
pnpm i -g jj-pr
npm i -g jj-pr
yarn global add jj-pr
```

optionally, configure as an alias in `.config/jj/config.toml`. This will let you use `jj pr` as an alias for `jj-pr`. The docs below will use `jj pr`, but the two are interchangeable.

```toml

[aliases]
# ....
# 
pr = ["util", "exec", "--", 'jj-pr', "$@"]
# or exec bun run jj-pr to use bun instead of node.
```

you can also configure a custom bookmark prefix in your `jj` config:

```toml
[jj-pr]
bookmark-prefix = "ta/jj/"
```

the default prefix is `<user>/jj/` derived from `user.email`.


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

@  lxnsotyp                         @                           9f5f5e48
│  (empty) (no description set)
◇  rqmkxwvo                         ta/jj/add-streaming-test    eeb7e010
│  add streaming test
◇  uvxnkynk                                                     dbb151e9
│  convert runBash to streamBash
◇  klrvwsvr                                                     59c4fda6
│  refactor bash utils
~
```
there's an existing bookmark at `rq`. If we want to introduce a new PR, say for `kl` where we do some refactoring that we want in a separate PR, `jj pr kl` will insert a new bookmark at `kl`, create a PR pointing to `trunk()`, and point the existing bookmark at `rq` to the new PR.

### Shell Completion

```sh
jj-pr completion zsh > "${fpath[1]}/_jj-pr"          # then restart zsh
jj-pr completion bash > /etc/bash_completion.d/jj-pr  # or >> ~/.bashrc
jj-pr completion fish > ~/.config/fish/completions/jj-pr.fish
```
