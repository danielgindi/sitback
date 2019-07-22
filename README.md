# sitback

[![npm Version](https://badge.fury.io/js/sitback.png)](https://npmjs.org/package/sitback)

A git diff based approach to package and deploy server apps of any kind.

The whole reason I created this, was that I has to do a lot of manual work around deployment,  
And that that manual work involved something that was not automated by any standard deployment/publishing system: Git diffs.  
If only one certain file changed, I only want to push that - to reduce deployment time and reduce server downtime.  
If some other files changed, I want to invoke a build system, and deploy the result.  

What this does is allow you to create a simple JSON script that defines the rules of when to package what and how, and then on the server side you can run the unpackage step with a single command.  

This can be integrated in whole pipelines.  
One example of such a pipeline would be:
1. Trigger a packaging step after a merge request or a tag
2. Push the package to a special git repo
3. A script on the server that periodically pulls if there is anything to pull
4. If there's a new package then unpack it with a single command
5. Restart `pm2`/`IIS`/etc.

Now I can `sitback` an relax.

## Documentation

Any help appreciated there.  
I'm trying to write more tests and to document more of the features available.  
In the meantime you can read the sources and the tests that exist.  

## Installation:

```
npm install --save sitback
```
  
## Usage example

Packing / unpacking:

```cmd
sitback --pack=deploy.json --base=C:\\Users\\User\\Projects\\git\\my_app" --out=C:\\Users\\User\\Projects\\out --git-from=prod_latest --git-to=prod_next

.
.
.

sitback --unpack=/var/incoming/my_app.json --out=/var/app
sitback --unpack=/var/incoming/another_app.json --out=/var/another_app
```

`deploy.json`:
```json
[
    {
        "name": "my_app",

        "variables": {
            "trigger_js_build": {
                "git_diff": { "pattern": "js/**/*" }
            },
            "trigger_net_build": {
                "git_diff": { "pattern": "core/**/*.cs" }
            }
        },
        
        "actions": [
            {
                "condition": "trigger_js_build",
                "type": "cmd",
                "description": "Building JS code...",
                "options": {
                    "path": "npm run build",
                    "args": ["--dist"]
                }
            },
            {
                "condition": "trigger_net_build",
                "type": "msbuild",
                "description": "Building .NET code...",
                "options": {
                    "solution": "core/app.sln",
                    "target": "app:Rebuild",
                    "props": {
                        "Configuration": "Release",
                        "Platform": "Any CPU"
                    }
                }
            }
        ],
        
        "package": [
            {
                "condition": "trigger_js_build",
                "source": "dist",
                "dest": "js",
                "pattern": "app.js",
                "mode": "sync"
            },
            {
                "condition": "trigger_net_build",
                "source": "core/Bin/Release",
                "dest": "bin",
                "pattern": "**/*",
                "mode": "sync"
            },
            {
                "condition": "trigger_net_build",
                "source": "libs",
                "dest": "bin",
                "pattern": "*.dll",
                "mode": "sync"
            },
            {
                "source": "resources",
                "dest": "resources",
                "pattern": "**/*",
                "mode": "git_diff"
            }
        ]
    },
    {
        "name": "another_app",

        "variables": {
            "trigger_js_build": {
                "git_diff": { "pattern": "js/**/*" }
            }
        },
        
        "actions": [
            {
                "condition": "trigger_js_build",
                "type": "cmd",
                "description": "Building JS code...",
                "options": {
                    "path": "npm run build",
                    "args": ["--dist"]
                }
            }
        ],
        
        "package": [
            {
                "condition": "trigger_js_build",
                "source": "dist",
                "dest": "js",
                "pattern": "app.js",
                "mode": "sync"
            },
            {
                "source": "resources",
                "dest": "resources",
                "pattern": "**/*",
                "mode": "git_diff"
            },
            {
                "source": "web.confg",
                "dest": "web.confg",
                "sourceXmlPath": "$.configuration.runtime",
                "destXmlPath": "$.configuration.runtime",
                "mode": "xml_replace"
            }
        ]
    }
]
```


## Contributing

If you have anything to contribute, or functionality that you lack - you are more than welcome to participate in this!
If anyone wishes to contribute unit tests - that also would be great :-)

## Me
* Hi! I am Daniel.
* danielgindi@gmail.com is my email address.
* That's all you need to know.

## Help

If you want to buy me a beer, you are very welcome to
[![Donate](https://www.paypalobjects.com/en_US/i/btn/btn_donate_LG.gif)](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=G6CELS3E997ZE)
 Thanks :-)

## License

All the code here is under MIT license. Which means you could do virtually anything with the code.
I will appreciate it very much if you keep an attribution where appropriate.

    The MIT License (MIT)

    Copyright (c) 2013 Daniel Cohen Gindi (danielgindi@gmail.com)

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.
