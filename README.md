# Description

Simple SSH tool.  
Uses mscdex's pure Javascript SSH2 module to try and make a PuTTY/MobaXterm alternative within vscode.  
A bit rough but makes my life easier so hopefully useful to others.  

## Settings
Either configure hosts in vscode settings as *"ssh-connect.hosts": []* or in .vscode/sshconnect.json as *"hosts": []*  
The latter is to allow stuff like storing hosts in source control. Hosts in vscode settings overrides hosts in sshconnect.json.

The id field defines the full path of the host in the tree view. If the path includes the id of another host, that hosts becomes a jump server.  
All other parts of the path becomes folders, which can be used to set defaults for contained hosts. This is done by creating a host entry without the "host" field.

### Example settings
[Check the SSH module documentation for connect configurations](https://github.com/mscdex/ssh2#client-methods)
```
{
  "hosts": [
    {
      "id": "somefolder",
      "iconPath": "${workspaceFolder}/.vscode/foldericon.png"
    },
    {
      "id": "somefolder/jumpserver",
      "host": "192.168.1.123",
      "username": "jumpuser",
      "password": "password",
      "port": 22
    },
    {
      "id": "somefolder/jumpserver/serverbehind",
      "host": "10.0.0.12",
      "username": "theuser",
      "password": "anotherpassword",
      "portForwards": [
        {
          "srcPort": 443,
          "dstPort": 443,
          "link": "https"
        }
      ]
    }
  ]
}
```
