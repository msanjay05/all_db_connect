package secure

import (
	"errors"
	"fmt"

	"github.com/zalando/go-keyring"
)

const serviceName = "my-wails-app.mysql-workbench"

type Keyring struct{}

func NewKeyring() *Keyring {
	return &Keyring{}
}

func (k *Keyring) SetPassword(profileID, password string) error {
	if password == "" {
		return nil
	}
	if err := keyring.Set(serviceName, profileID, password); err != nil {
		return fmt.Errorf("store password in keychain: %w", err)
	}
	return nil
}

func (k *Keyring) GetPassword(profileID string) (string, error) {
	password, err := keyring.Get(serviceName, profileID)
	if err != nil {
		if errors.Is(err, keyring.ErrNotFound) {
			return "", nil
		}
		return "", fmt.Errorf("read password from keychain: %w", err)
	}
	return password, nil
}

func (k *Keyring) DeletePassword(profileID string) error {
	if err := keyring.Delete(serviceName, profileID); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return fmt.Errorf("delete password from keychain: %w", err)
	}
	return nil
}
