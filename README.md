* make sure to also create security group allowing all traffic to 25565 and MY IP to ssh in. apply that to the ec2.
* use arm linux 2 AMI with t4g.medium instance
* ssh in with `ssh -i ~/path/to/your‑key.pem ec2-user@YOUR_PUBLIC_IP`
* see status: `sudo systemctl status minecraft.service`
* see live output from mc server: `sudo journalctl -u minecraft.service -f`
* see logs from shell init:  `vi /var/log/cloud-init-output.log`
