# Description

Simple SSH tool.  
Uses mscdex's pure Javascript SSH2 module to try and make a PuTTY/MobaXterm alternative within vscode.  
A bit rough but makes my life easier so hopefully useful to others.  

### Example .vscode/sshconnect.json
[Check the SSH module documentation for connect configurations](https://github.com/mscdex/ssh2#client-methods)
```
{
  "ssh-connect.hosts": [
    {
      "id": "somefolder",
      "iconPath": "C:\\Users\\user\\Pictures\\CompanyIcon.png"
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
      "port": 22,
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
Hosts can also be set in .vscode/sshconnect.json using "hosts" instead of "ssh-connect.hosts"
